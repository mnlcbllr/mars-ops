//! Typed contingency events for a running simulated mission.
//!
//! Events are declared inputs, not observations: a blocked corridor is a
//! hypothetical constraint, a delay is simulated extra time, and a resource
//! loss reduces the remaining modeled budget. Nothing here changes the
//! packaged dataset, and nothing claims that an event happened on Mars.

use crate::planning::MissionScenario;
use crate::route::{BlockOverlay, OverlayError};
use crate::terrain::PlanningGrid;
use crate::LocalPoint;
use serde::{Deserialize, Serialize};

/// Longest simulated delay one event may inject (24 h), a prototype guard
/// against unusable state rather than a physical limit.
pub const MAX_DELAY_S: f64 = 86_400.0;
/// Largest blocked corridor radius one event may declare, metres.
pub const MAX_CORRIDOR_RADIUS_M: f64 = 1_000.0;

/// Which modeled resource an adjustment affects.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ResourceKind {
    EvaTime,
    Energy,
    Consumable,
}

impl ResourceKind {
    pub fn label(self) -> &'static str {
        match self {
            ResourceKind::EvaTime => "EVA time",
            ResourceKind::Energy => "energy",
            ResourceKind::Consumable => "consumable",
        }
    }
}

/// One planning cell, in lattice coordinates (row 0 is north).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GridCellRef {
    pub col: usize,
    pub row: usize,
}

/// The typed payload of a contingency.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ContingencyKind {
    /// Specific planning cells become impassable for future routing.
    BlockCells { cells: Vec<GridCellRef> },
    /// Every planning cell whose centre lies within the radius becomes impassable.
    BlockCorridor { center: LocalPoint, radius_m: f64 },
    /// Additional simulated time at the current position.
    Delay { seconds: f64 },
    /// A nonnegative reduction of the remaining modeled budget.
    ResourceLoss { resource: ResourceKind, amount: f64 },
}

impl ContingencyKind {
    pub fn label(&self) -> &'static str {
        match self {
            ContingencyKind::BlockCells { .. } => "blocked cells",
            ContingencyKind::BlockCorridor { .. } => "blocked corridor",
            ContingencyKind::Delay { .. } => "delay",
            ContingencyKind::ResourceLoss { .. } => "resource loss",
        }
    }
}

/// An event stamped with the simulated clock when it was injected.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ContingencyEvent {
    pub id: u64,
    pub at_elapsed_s: f64,
    pub kind: ContingencyKind,
}

/// Why an event was refused.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum ContingencyError {
    #[error("the event declares no cells")]
    EmptyBlock,
    #[error("cell ({col}, {row}) is outside the planning lattice")]
    CellOutsideGrid { col: usize, row: usize },
    #[error("the corridor centre lies outside the elevation coverage")]
    CenterOutsideCoverage,
    #[error("the corridor radius must be greater than zero and at most {MAX_CORRIDOR_RADIUS_M:.0} m")]
    InvalidRadius,
    #[error("the delay must be between 0 and {MAX_DELAY_S:.0} simulated seconds")]
    InvalidDelay,
    #[error("the resource loss must be a finite positive amount")]
    InvalidAmount,
    #[error("no {resource} budget is declared, so it cannot be reduced")]
    NoBudget { resource: &'static str },
    #[error(transparent)]
    Overlay(#[from] OverlayError),
}

impl ContingencyKind {
    /// Check the event against the lattice and the scenario's declared budgets.
    /// Rejects invalid geometry instead of clamping it silently.
    pub fn validate(
        &self,
        grid: &PlanningGrid,
        scenario: &MissionScenario,
    ) -> Result<(), ContingencyError> {
        match self {
            ContingencyKind::BlockCells { cells } => {
                if cells.is_empty() {
                    return Err(ContingencyError::EmptyBlock);
                }
                for cell in cells {
                    if cell.col >= grid.width || cell.row >= grid.height {
                        return Err(ContingencyError::CellOutsideGrid { col: cell.col, row: cell.row });
                    }
                }
                Ok(())
            }
            ContingencyKind::BlockCorridor { center, radius_m } => {
                if !(radius_m.is_finite() && *radius_m > 0.0 && *radius_m <= MAX_CORRIDOR_RADIUS_M) {
                    return Err(ContingencyError::InvalidRadius);
                }
                if grid.cell_of(*center).is_none() {
                    return Err(ContingencyError::CenterOutsideCoverage);
                }
                Ok(())
            }
            ContingencyKind::Delay { seconds } => {
                if !(seconds.is_finite() && *seconds >= 0.0 && *seconds <= MAX_DELAY_S) {
                    return Err(ContingencyError::InvalidDelay);
                }
                Ok(())
            }
            ContingencyKind::ResourceLoss { resource, amount } => {
                if !(amount.is_finite() && *amount > 0.0) {
                    return Err(ContingencyError::InvalidAmount);
                }
                let declared = match resource {
                    ResourceKind::EvaTime => true,
                    ResourceKind::Energy => scenario.budget.energy_budget_wh.is_some(),
                    ResourceKind::Consumable => scenario.budget.consumable_budget.is_some(),
                };
                if !declared {
                    return Err(ContingencyError::NoBudget { resource: resource.label() });
                }
                Ok(())
            }
        }
    }

    /// Add this event's cells to `overlay`. Delay and resource events do not
    /// touch the route graph and add nothing.
    pub fn apply_to_overlay(
        &self,
        grid: &PlanningGrid,
        overlay: &mut BlockOverlay,
    ) -> Result<usize, ContingencyError> {
        match self {
            ContingencyKind::BlockCells { cells } => {
                let mut added = 0;
                for cell in cells {
                    if overlay.block_index(grid.index(cell.col, cell.row)) {
                        added += 1;
                    }
                }
                Ok(added)
            }
            ContingencyKind::BlockCorridor { center, radius_m } => {
                Ok(overlay.block_disc(grid, *center, *radius_m)?)
            }
            ContingencyKind::Delay { .. } | ContingencyKind::ResourceLoss { .. } => Ok(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planning::plan_greedy;
    use crate::provenance::EvidenceKind;
    use crate::resources::test_support::{bare_model, time_only};
    use crate::route::test_support::{at, flat, WALK};
    use crate::planning::ScientificSite;

    fn scenario(grid: &PlanningGrid) -> MissionScenario {
        let mut budget = time_only(1000.0, 100.0);
        budget.energy_budget_wh = Some(500.0);
        budget.energy_reserve_wh = Some(50.0);
        MissionScenario {
            schema_version: 1,
            name: "fixture".into(),
            dataset_id: "synthetic".into(),
            base: at(grid, 2, 2),
            sites: vec![ScientificSite {
                id: "A".into(),
                name: "A".into(),
                position: at(grid, 6, 2),
                science_rationale: "test".into(),
                source_product_ids: vec![],
                evidence_kind: EvidenceKind::Synthetic,
                activity_min_s: 10.0,
                activity_max_s: 20.0,
                activity_power_w: 10.0,
                preference_weight: 1.0,
                required: false,
            }],
            budget,
            model: bare_model(),
        }
    }

    #[test]
    fn cell_blocks_must_be_inside_the_lattice_and_non_empty() {
        let grid = flat(9, 9, 1.0);
        let scenario = scenario(&grid);
        let ok = ContingencyKind::BlockCells { cells: vec![GridCellRef { col: 4, row: 4 }] };
        assert_eq!(ok.validate(&grid, &scenario), Ok(()));
        let empty = ContingencyKind::BlockCells { cells: vec![] };
        assert_eq!(empty.validate(&grid, &scenario), Err(ContingencyError::EmptyBlock));
        let outside = ContingencyKind::BlockCells { cells: vec![GridCellRef { col: 9, row: 0 }] };
        assert_eq!(
            outside.validate(&grid, &scenario),
            Err(ContingencyError::CellOutsideGrid { col: 9, row: 0 })
        );
    }

    #[test]
    fn corridor_geometry_is_bounded() {
        let grid = flat(9, 9, 1.0);
        let scenario = scenario(&grid);
        let center = at(&grid, 4, 4);
        let good = ContingencyKind::BlockCorridor { center, radius_m: 3.0 };
        assert_eq!(good.validate(&grid, &scenario), Ok(()));
        for radius_m in [0.0, -1.0, f64::NAN, MAX_CORRIDOR_RADIUS_M + 1.0] {
            let bad = ContingencyKind::BlockCorridor { center, radius_m };
            assert_eq!(bad.validate(&grid, &scenario), Err(ContingencyError::InvalidRadius));
        }
        let outside = ContingencyKind::BlockCorridor { center: LocalPoint::new(-1.0, 2.0), radius_m: 3.0 };
        assert_eq!(outside.validate(&grid, &scenario), Err(ContingencyError::CenterOutsideCoverage));
    }

    #[test]
    fn delay_and_resource_loss_are_validated_against_the_declared_model() {
        let grid = flat(9, 9, 1.0);
        let scenario = scenario(&grid);
        assert_eq!(ContingencyKind::Delay { seconds: 60.0 }.validate(&grid, &scenario), Ok(()));
        assert_eq!(
            ContingencyKind::Delay { seconds: -1.0 }.validate(&grid, &scenario),
            Err(ContingencyError::InvalidDelay)
        );
        assert_eq!(
            ContingencyKind::Delay { seconds: MAX_DELAY_S + 1.0 }.validate(&grid, &scenario),
            Err(ContingencyError::InvalidDelay)
        );
        let energy = ContingencyKind::ResourceLoss { resource: ResourceKind::Energy, amount: 10.0 };
        assert_eq!(energy.validate(&grid, &scenario), Ok(()));
        let time = ContingencyKind::ResourceLoss { resource: ResourceKind::EvaTime, amount: 10.0 };
        assert_eq!(time.validate(&grid, &scenario), Ok(()));
        let no_consumable =
            ContingencyKind::ResourceLoss { resource: ResourceKind::Consumable, amount: 10.0 };
        assert_eq!(
            no_consumable.validate(&grid, &scenario),
            Err(ContingencyError::NoBudget { resource: "consumable" })
        );
        let zero = ContingencyKind::ResourceLoss { resource: ResourceKind::Energy, amount: 0.0 };
        assert_eq!(zero.validate(&grid, &scenario), Err(ContingencyError::InvalidAmount));
    }

    #[test]
    fn applying_a_block_changes_routing_without_changing_the_terrain() {
        let grid = flat(9, 9, 1.0);
        let scenario = scenario(&grid);
        let before = plan_greedy(&grid, &scenario);
        let mut overlay = BlockOverlay::new(grid.width, grid.height);
        let event = ContingencyKind::BlockCells { cells: vec![GridCellRef { col: 4, row: 2 }] };
        assert_eq!(event.apply_to_overlay(&grid, &mut overlay), Ok(1));
        let leg = crate::route::find_leg_avoiding(
            &grid,
            &WALK,
            scenario.base,
            scenario.sites[0].position,
            crate::route::Search::AStar,
            Some(&overlay),
        )
        .unwrap();
        assert!(leg.path.iter().all(|p| grid.cell_of(*p) != Some((4, 2))));
        assert_eq!(grid.slope_deg, vec![0.0; 81]);
        assert_eq!(before.status, crate::planning::PlanStatus::FeasibleModeled);
    }
}
