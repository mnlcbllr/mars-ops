//! Typed contingency events a mission designer can inject into a running
//! simulated mission, and their validation.
//!
//! An event never modifies the elevation data, the planning grid or any
//! stored NASA product: a blockage is a *routing overlay* for future legs only
//! (see [`crate::route::find_leg_masked`]). A delay adds simulated time at the
//! declared standing load. A resource adjustment reduces what is left of a
//! declared budget; it does not claim anything happened on Mars.

use crate::LocalPoint;
use serde::{Deserialize, Serialize};

/// A planning-lattice cell addressed by column and row (row 0 = north).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CellRef {
    pub col: usize,
    pub row: usize,
}

/// Which declared budget an adjustment reduces.
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

/// One injected contingency. Every variant carries the user's reason so the
/// event history reads as a log, not as a measurement.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ContingencyEvent {
    /// Cells that become impassable for future routing. Temporary: the
    /// terrain itself and every stored product are untouched.
    BlockCells {
        cells: Vec<CellRef>,
        reason: String,
    },
    /// Additional simulated time at the declared standing load (base power and
    /// the activity-rate consumable, like the model's overhead bucket).
    Delay {
        seconds: f64,
        reason: String,
    },
    /// Reduce what remains of one declared budget. MODELED scenario input.
    ResourceAdjustment {
        resource: ResourceKind,
        amount: f64,
        reason: String,
    },
}

impl ContingencyEvent {
    /// Short human label for logs and the UI.
    pub fn summary(&self) -> String {
        match self {
            ContingencyEvent::BlockCells { cells, .. } => {
                format!("blocked {} planning cell{}", cells.len(), if cells.len() == 1 { "" } else { "s" })
            }
            ContingencyEvent::Delay { seconds, .. } => format!("delay of {seconds:.0} s"),
            ContingencyEvent::ResourceAdjustment { resource, amount, .. } => {
                format!("loss of {amount:.3} {}", resource.label())
            }
        }
    }

    /// Why the event cannot be applied to the current mission, if it cannot.
    ///
    /// `occupied` is the lattice cell the simulated crew currently occupies;
    /// blocking it would strand them inside an obstacle, so it is refused.
    pub fn validate(
        &self,
        grid_width: usize,
        grid_height: usize,
        occupied: Option<CellRef>,
        remaining: &RemainingBudgets,
    ) -> Result<(), ContingencyError> {
        match self {
            ContingencyEvent::BlockCells { cells, .. } => {
                if cells.is_empty() {
                    return Err(ContingencyError::InvalidEvent("the blockage has no cells".into()));
                }
                if cells.len() > MAX_BLOCKED_CELLS {
                    return Err(ContingencyError::InvalidEvent(format!(
                        "{} blocked cells; at most {MAX_BLOCKED_CELLS} are supported",
                        cells.len()
                    )));
                }
                for &cell in cells {
                    if cell.col >= grid_width || cell.row >= grid_height {
                        return Err(ContingencyError::InvalidEvent(format!(
                            "cell ({}, {}) is outside the {} × {} planning grid",
                            cell.col, cell.row, grid_width, grid_height
                        )));
                    }
                    if occupied == Some(cell) {
                        return Err(ContingencyError::InvalidEvent(
                            "the crew occupies that cell; move the blockage away from them".into(),
                        ));
                    }
                }
                Ok(())
            }
            ContingencyEvent::Delay { seconds, .. } => {
                if !seconds.is_finite() || *seconds < 0.0 {
                    return Err(ContingencyError::InvalidEvent(format!(
                        "delay must be a non-negative number of seconds (got {seconds})"
                    )));
                }
                if *seconds == 0.0 {
                    return Err(ContingencyError::InvalidEvent("the delay is zero seconds".into()));
                }
                Ok(())
            }
            ContingencyEvent::ResourceAdjustment { resource, amount, .. } => {
                if !amount.is_finite() || *amount < 0.0 {
                    return Err(ContingencyError::InvalidEvent(format!(
                        "{} loss must be a non-negative number (got {amount})",
                        resource.label()
                    )));
                }
                let left = match resource {
                    ResourceKind::EvaTime => remaining.eva_time_s,
                    ResourceKind::Energy => remaining.energy_wh,
                    ResourceKind::Consumable => remaining.consumable,
                };
                let Some(left) = left else {
                    return Err(ContingencyError::InvalidEvent(format!(
                        "{} has no declared budget to reduce",
                        resource.label()
                    )));
                };
                if *amount > left {
                    return Err(ContingencyError::InvalidEvent(format!(
                        "{} loss of {amount:.3} exceeds the {:.3} still available after the reserve and prior events",
                        resource.label(),
                        left
                    )));
                }
                Ok(())
            }
        }
    }
}

/// What is still available of each declared budget: `budget − reserve −
/// prior adjustments`. `None` where no budget is declared.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RemainingBudgets {
    pub eva_time_s: Option<f64>,
    pub energy_wh: Option<f64>,
    pub consumable: Option<f64>,
}

/// Most cells one event may block. Routing work stays bounded even for a
/// hand-built event payload.
pub const MAX_BLOCKED_CELLS: usize = 4096;

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum ContingencyError {
    #[error("InvalidEvent: {0}")]
    InvalidEvent(String),
}

/// Expand a centre point and a radius in metres into the set of planning
/// cells whose centres lie inside the circle. Used by the UI's bounded
/// preview and by tests; the core never guesses cells from raw points.
pub fn cells_within_radius(
    width: usize,
    height: usize,
    cell_x_m: f64,
    cell_y_m: f64,
    centre: LocalPoint,
    radius_m: f64,
) -> Vec<CellRef> {
    let mut cells = Vec::new();
    if width == 0 || height == 0 || !cell_x_m.is_finite() || !cell_y_m.is_finite()
        || cell_x_m <= 0.0 || cell_y_m <= 0.0 || !radius_m.is_finite() || radius_m < 0.0
        || radius_m > 1000.0 {
        return cells;
    }
    let Some((ccol, crow)) = cell_of_point(width, height, cell_x_m, cell_y_m, centre) else {
        return cells;
    };
    let reach_col = ((radius_m / cell_x_m).ceil() as usize).saturating_add(1);
    let reach_row = ((radius_m / cell_y_m).ceil() as usize).saturating_add(1);
    for row in crow.saturating_sub(reach_row)..=crow.saturating_add(reach_row).min(height - 1) {
        for col in ccol.saturating_sub(reach_col)..=ccol.saturating_add(reach_col).min(width - 1) {
            let (cx, cy) = cell_center(height, cell_x_m, cell_y_m, col, row);
            if (cx - centre.x_m).hypot(cy - centre.y_m) <= radius_m {
                cells.push(CellRef { col, row });
            }
        }
    }
    cells
}

fn cell_of_point(
    width: usize,
    height: usize,
    cell_x_m: f64,
    cell_y_m: f64,
    p: LocalPoint,
) -> Option<(usize, usize)> {
    if !(p.x_m >= 0.0 && p.x_m < width as f64 * cell_x_m) {
        return None;
    }
    let col = ((p.x_m / cell_x_m) as usize).min(width - 1);
    let row_from_south = ((p.y_m / cell_y_m) as usize).min(height - 1);
    if !(p.y_m >= 0.0 && p.y_m < height as f64 * cell_y_m) {
        return None;
    }
    Some((col, height - 1 - row_from_south))
}

fn cell_center(
    height: usize,
    cell_x_m: f64,
    cell_y_m: f64,
    col: usize,
    row: usize,
) -> (f64, f64) {
    (
        (col as f64 + 0.5) * cell_x_m,
        (height as f64 - row as f64 - 0.5) * cell_y_m,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remaining(eva: f64) -> RemainingBudgets {
        RemainingBudgets {
            eva_time_s: Some(eva),
            energy_wh: Some(100.0),
            consumable: Some(1.0),
        }
    }

    #[test]
    fn blockage_must_be_in_bounds_and_nonempty() {
        let occupied = Some(CellRef { col: 2, row: 2 });
        let ok = ContingencyEvent::BlockCells {
            cells: vec![CellRef { col: 0, row: 0 }],
            reason: "rockfall".into(),
        };
        assert!(ok.validate(8, 8, occupied, &remaining(600.0)).is_ok());

        let empty = ContingencyEvent::BlockCells { cells: vec![], reason: "x".into() };
        assert!(matches!(empty.validate(8, 8, None, &remaining(600.0)), Err(ContingencyError::InvalidEvent(_))));

        let outside = ContingencyEvent::BlockCells {
            cells: vec![CellRef { col: 8, row: 0 }],
            reason: "x".into(),
        };
        assert!(matches!(outside.validate(8, 8, None, &remaining(600.0)), Err(ContingencyError::InvalidEvent(_))));

        let on_crew = ContingencyEvent::BlockCells {
            cells: vec![CellRef { col: 2, row: 2 }],
            reason: "x".into(),
        };
        assert!(matches!(on_crew.validate(8, 8, occupied, &remaining(600.0)), Err(ContingencyError::InvalidEvent(_))));
    }

    #[test]
    fn delay_must_be_positive_and_finite() {
        let ok = ContingencyEvent::Delay { seconds: 60.0, reason: "x".into() };
        assert!(ok.validate(8, 8, None, &remaining(600.0)).is_ok());
        for bad in [0.0, -1.0, f64::NAN] {
            let e = ContingencyEvent::Delay { seconds: bad, reason: "x".into() };
            assert!(matches!(e.validate(8, 8, None, &remaining(600.0)), Err(ContingencyError::InvalidEvent(_))));
        }
    }

    #[test]
    fn adjustment_needs_a_declared_budget_and_may_not_overdraw_it() {
        let no_budget = RemainingBudgets::default();
        let e = ContingencyEvent::ResourceAdjustment {
            resource: ResourceKind::Energy,
            amount: 1.0,
            reason: "x".into(),
        };
        assert!(matches!(e.validate(8, 8, None, &no_budget), Err(ContingencyError::InvalidEvent(_))));

        let over = ContingencyEvent::ResourceAdjustment {
            resource: ResourceKind::Consumable,
            amount: 1.5,
            reason: "x".into(),
        };
        assert!(matches!(over.validate(8, 8, None, &remaining(600.0)), Err(ContingencyError::InvalidEvent(_))));

        let exact = ContingencyEvent::ResourceAdjustment {
            resource: ResourceKind::Consumable,
            amount: 1.0,
            reason: "x".into(),
        };
        assert!(exact.validate(8, 8, None, &remaining(600.0)).is_ok());

        let negative = ContingencyEvent::ResourceAdjustment {
            resource: ResourceKind::EvaTime,
            amount: -1.0,
            reason: "x".into(),
        };
        assert!(matches!(negative.validate(8, 8, None, &remaining(600.0)), Err(ContingencyError::InvalidEvent(_))));
    }

    #[test]
    fn radius_picks_the_cells_whose_centres_are_inside() {
        // 5 × 5 grid of 2 m cells; centre at cell (2, 2) = (5, 5) in metres.
        let cells = cells_within_radius(5, 5, 2.0, 2.0, LocalPoint::new(5.0, 5.0), 2.0);
        let picked: Vec<(usize, usize)> = cells.iter().map(|c| (c.col, c.row)).collect();
        assert_eq!(picked.len(), 5, "cross of cells within 2 m: {picked:?}");
        for (col, row) in picked {
            assert!((col as i64 - 2).abs() + (row as i64 - 2).abs() <= 2);
        }
        assert!(cells_within_radius(5, 5, 2.0, 2.0, LocalPoint::new(50.0, 5.0), 2.0).is_empty());
        assert!(cells_within_radius(5, 5, 2.0, 2.0, LocalPoint::new(5.0, 5.0), -1.0).is_empty());
    }

    #[test]
    fn events_survive_a_json_round_trip() {
        let events = vec![
            ContingencyEvent::BlockCells {
                cells: vec![CellRef { col: 1, row: 2 }, CellRef { col: 1, row: 3 }],
                reason: "blocked corridor".into(),
            },
            ContingencyEvent::Delay { seconds: 120.0, reason: "dust".into() },
            ContingencyEvent::ResourceAdjustment {
                resource: ResourceKind::Consumable,
                amount: 0.1,
                reason: "leak".into(),
            },
        ];
        let json = serde_json::to_string(&events).unwrap();
        assert_eq!(serde_json::from_str::<Vec<ContingencyEvent>>(&json).unwrap(), events);
        assert!(json.contains("\"BLOCK_CELLS\"") && json.contains("\"kind\""));
    }
}
