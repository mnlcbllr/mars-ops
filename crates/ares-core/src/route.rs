//! Terrain-aware routing of one leg on the planning lattice.
//!
//! This answers only "which connected path is traversable between two points
//! under a declared model". Choosing which sites to visit is `planning`.
//!
//! Model (all parameters are scenario assumptions, not certified limits):
//! * a cell is traversable if its elevation and slope are known and its slope
//!   does not exceed `max_slope_deg`;
//! * moves go to the 8 neighbours; a diagonal move is allowed only if both
//!   cells it squeezes between are traversable (no corner cutting);
//! * a move of horizontal length `h` and height change `dz` covers surface
//!   distance `s = √(h² + dz²)` and takes `s / flat_speed · (1 + penalty·|dz|/h)`.

use crate::terrain::PlanningGrid;
use crate::LocalPoint;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, VecDeque};

/// Numeric traversal assumptions used by the router.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TraversalModel {
    pub max_slope_deg: f64,
    pub flat_speed_m_s: f64,
    pub slope_time_penalty: f64,
}

/// Which end of a leg a problem refers to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Endpoint {
    Start,
    Goal,
}

/// Search strategy. Both return a minimum-time path; Dijkstra exists to check A*.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Search {
    AStar,
    Dijkstra,
}

/// A per-run set of planning cells made impassable by a contingency.
///
/// The overlay never touches the dataset: it only hides cells from routing and
/// simulation for the current mission attempt. Cells are stored as sorted
/// linear indices so it serializes sparsely and checks in `O(log n)`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockOverlay {
    pub width: usize,
    pub height: usize,
    /// Sorted, deduplicated linear cell indices (`row * width + col`).
    pub cells: Vec<u32>,
}

impl BlockOverlay {
    pub fn new(width: usize, height: usize) -> Self {
        Self { width, height, cells: Vec::new() }
    }

    /// True when the overlay describes the same lattice as `grid`.
    pub fn covers(&self, grid: &PlanningGrid) -> bool {
        self.width == grid.width && self.height == grid.height
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    pub fn len(&self) -> usize {
        self.cells.len()
    }

    /// Whether the planning cell `idx` is blocked in this overlay.
    pub fn contains(&self, idx: usize) -> bool {
        self.cells.binary_search(&(idx as u32)).is_ok()
    }

    /// Block one cell and return whether it was newly blocked.
    pub fn block_index(&mut self, idx: usize) -> bool {
        match self.cells.binary_search(&(idx as u32)) {
            Ok(_) => false,
            Err(position) => {
                self.cells.insert(position, idx as u32);
                true
            }
        }
    }

    /// Block the cell containing `p`; `None` when `p` is outside the lattice.
    pub fn block_point(&mut self, grid: &PlanningGrid, p: LocalPoint) -> Option<bool> {
        let (col, row) = grid.cell_of(p)?;
        Some(self.block_index(grid.index(col, row)))
    }

    /// Block every cell whose centre lies within `radius_m` of `center`.
    /// Returns the number of newly blocked cells. The radius is capped at the
    /// lattice diagonal and must be finite and positive.
    pub fn block_disc(
        &mut self,
        grid: &PlanningGrid,
        center: LocalPoint,
        radius_m: f64,
    ) -> Result<usize, OverlayError> {
        if !self.covers(grid) {
            return Err(OverlayError::LatticeMismatch);
        }
        if !(radius_m.is_finite() && radius_m > 0.0) {
            return Err(OverlayError::InvalidRadius);
        }
        grid.cell_of(center).ok_or(OverlayError::CenterOutsideCoverage)?;
        let diagonal = (grid.width as f64 * grid.cell_x_m).hypot(grid.height as f64 * grid.cell_y_m);
        let radius = radius_m.min(diagonal);
        let mut added = 0;
        for r in 0..grid.height {
            for c in 0..grid.width {
                let p = grid.cell_center(c, r);
                if (p.x_m - center.x_m).hypot(p.y_m - center.y_m) <= radius {
                    if self.block_index(grid.index(c, r)) {
                        added += 1;
                    }
                }
            }
        }
        Ok(added)
    }

    /// `(col, row)` of every blocked cell, for display.
    pub fn blocked_cells(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        let width = self.width;
        self.cells.iter().map(move |&idx| {
            let idx = idx as usize;
            (idx % width, idx / width)
        })
    }
}

/// Why a block overlay could not be applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum OverlayError {
    #[error("the block overlay belongs to a different planning lattice")]
    LatticeMismatch,
    #[error("the blocked area radius must be a positive finite distance")]
    InvalidRadius,
    #[error("the blocked area centre lies outside the elevation coverage")]
    CenterOutsideCoverage,
}

/// Per-step surface cost used by the simulator to walk a planned leg.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct StepMetric {
    pub distance_m: f64,
    pub time_s: f64,
}

/// A routed leg between two planning cells.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Leg {
    /// Planning-cell centres from start to goal, inclusive.
    pub path: Vec<LocalPoint>,
    /// Planning-cell elevation at each path point, metres.
    pub elevation_m: Vec<f32>,
    /// Along-surface distance, metres.
    pub distance_m: f64,
    /// Modeled traversal time, seconds.
    pub time_s: f64,
    pub ascent_m: f64,
    pub descent_m: f64,
    /// Largest cell slope along the path, degrees.
    pub max_slope_deg: f64,
    /// Search effort: cells taken off the open list.
    pub cells_expanded: usize,
}

/// Why no leg could be produced.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "code", rename_all = "PascalCase")]
pub enum RouteError {
    #[error("{endpoint:?} point lies outside the elevation coverage")]
    OutsideCoverage { endpoint: Endpoint },
    #[error("{endpoint:?} point lies on terrain with no elevation data")]
    UnknownTerrainAtEndpoint { endpoint: Endpoint },
    #[error("{endpoint:?} point lies on a {slope_deg:.1}° slope, above the scenario limit")]
    SlopeRuleAtEndpoint { endpoint: Endpoint, slope_deg: f64 },
    #[error("{endpoint:?} point lies in an area blocked by a declared contingency")]
    EndpointBlocked { endpoint: Endpoint },
    #[error("the only connections cross terrain with no elevation data")]
    RouteCrossesUnknownTerrain,
    #[error("no connection exists under the scenario slope limit")]
    BlockedBySlopeRule,
}

/// Minimum-time leg from `from` to `to` on `grid` under `model`.
pub fn find_leg(
    grid: &PlanningGrid,
    model: &TraversalModel,
    from: LocalPoint,
    to: LocalPoint,
    search: Search,
) -> Result<Leg, RouteError> {
    find_leg_avoiding(grid, model, from, to, search, None)
}

/// Minimum-time leg that also refuses cells blocked by `blocked`.
///
/// The overlay is a routing input only; `grid` is never modified. Passing
/// `None` is exactly [`find_leg`].
pub fn find_leg_avoiding(
    grid: &PlanningGrid,
    model: &TraversalModel,
    from: LocalPoint,
    to: LocalPoint,
    search: Search,
    blocked: Option<&BlockOverlay>,
) -> Result<Leg, RouteError> {
    let start = locate(grid, model, from, Endpoint::Start, blocked)?;
    let goal = locate(grid, model, to, Endpoint::Goal, blocked)?;
    let n = grid.width * grid.height;
    let (goal_col, goal_row) = (goal % grid.width, goal / grid.width);
    let heuristic = |idx: usize| -> f64 {
        match search {
            Search::Dijkstra => 0.0,
            // Straight-line horizontal distance at flat speed never overestimates:
            // every move covers at least its horizontal length at no more than flat speed.
            Search::AStar => {
                let dc = (idx % grid.width) as f64 - goal_col as f64;
                let dr = (idx / grid.width) as f64 - goal_row as f64;
                (dc * grid.cell_x_m).hypot(dr * grid.cell_y_m) / model.flat_speed_m_s
            }
        }
    };

    let mut best_time = vec![f64::INFINITY; n];
    let mut came_from = vec![u32::MAX; n];
    let mut closed = vec![false; n];
    let mut open = BinaryHeap::new();
    best_time[start] = 0.0;
    open.push(Open { priority: heuristic(start), time_s: 0.0, idx: start as u32 });
    let mut cells_expanded = 0;

    while let Some(Open { time_s, idx, .. }) = open.pop() {
        let idx = idx as usize;
        if closed[idx] {
            continue;
        }
        closed[idx] = true;
        cells_expanded += 1;
        if idx == goal {
            return Ok(build_leg(grid, model, &came_from, goal, cells_expanded));
        }
        for next in neighbours(grid, idx, |i| traversable(grid, model, i) && !blocked_at(blocked, i)) {
            if closed[next] {
                continue;
            }
            let candidate = time_s + step(grid, model, idx, next).time_s;
            if candidate < best_time[next] {
                best_time[next] = candidate;
                came_from[next] = idx as u32;
                open.push(Open {
                    priority: candidate + heuristic(next),
                    time_s: candidate,
                    idx: next as u32,
                });
            }
        }
    }

    // No route. Say whether missing data or the slope rule is what stands in the way.
    let known_or_passable =
        |i: usize| is_unknown(grid, i) || (traversable(grid, model, i) && !blocked_at(blocked, i));
    if connected(grid, start, goal, known_or_passable) {
        Err(RouteError::RouteCrossesUnknownTerrain)
    } else {
        Err(RouteError::BlockedBySlopeRule)
    }
}

/// Open-list entry ordered so the smallest priority pops first, with
/// deterministic tie-breaking.
#[derive(PartialEq)]
struct Open {
    priority: f64,
    time_s: f64,
    idx: u32,
}

impl Eq for Open {}

impl Ord for Open {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .priority
            .total_cmp(&self.priority)
            .then(self.time_s.total_cmp(&other.time_s))
            .then(other.idx.cmp(&self.idx))
    }
}

impl PartialOrd for Open {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn is_unknown(grid: &PlanningGrid, idx: usize) -> bool {
    grid.elevation_m[idx].is_nan() || grid.slope_deg[idx].is_nan()
}

fn traversable(grid: &PlanningGrid, model: &TraversalModel, idx: usize) -> bool {
    !is_unknown(grid, idx) && grid.slope_deg[idx] as f64 <= model.max_slope_deg
}

fn blocked_at(blocked: Option<&BlockOverlay>, idx: usize) -> bool {
    blocked.is_some_and(|b| b.contains(idx))
}

fn locate(
    grid: &PlanningGrid,
    model: &TraversalModel,
    p: LocalPoint,
    endpoint: Endpoint,
    blocked: Option<&BlockOverlay>,
) -> Result<usize, RouteError> {
    let (col, row) = grid.cell_of(p).ok_or(RouteError::OutsideCoverage { endpoint })?;
    let idx = grid.index(col, row);
    if is_unknown(grid, idx) {
        return Err(RouteError::UnknownTerrainAtEndpoint { endpoint });
    }
    if !traversable(grid, model, idx) {
        return Err(RouteError::SlopeRuleAtEndpoint {
            endpoint,
            slope_deg: grid.slope_deg[idx] as f64,
        });
    }
    if blocked_at(blocked, idx) {
        return Err(RouteError::EndpointBlocked { endpoint });
    }
    Ok(idx)
}

/// Neighbours of `idx` reachable in one move among cells accepted by `allowed`.
fn neighbours<'a>(
    grid: &'a PlanningGrid,
    idx: usize,
    allowed: impl Fn(usize) -> bool + 'a,
) -> impl Iterator<Item = usize> + 'a {
    const MOVES: [(isize, isize); 8] =
        [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)];
    let (col, row) = ((idx % grid.width) as isize, (idx / grid.width) as isize);
    let at = move |c: isize, r: isize| -> Option<usize> {
        (c >= 0 && r >= 0 && (c as usize) < grid.width && (r as usize) < grid.height)
            .then(|| r as usize * grid.width + c as usize)
    };
    MOVES.iter().filter_map(move |&(dc, dr)| {
        let next = at(col + dc, row + dr).filter(|&i| allowed(i))?;
        if dc != 0 && dr != 0 {
            // A diagonal passes the corner shared with two other cells; both must be open.
            let side_a = at(col + dc, row).filter(|&i| allowed(i));
            let side_b = at(col, row + dr).filter(|&i| allowed(i));
            if side_a.is_none() || side_b.is_none() {
                return None;
            }
        }
        Some(next)
    })
}

struct Step {
    distance_m: f64,
    time_s: f64,
    rise_m: f64,
}

/// Cost of moving between two adjacent cells.
fn step(grid: &PlanningGrid, model: &TraversalModel, from: usize, to: usize) -> Step {
    let dc = (to % grid.width) as f64 - (from % grid.width) as f64;
    let dr = (to / grid.width) as f64 - (from / grid.width) as f64;
    let horizontal = (dc * grid.cell_x_m).hypot(dr * grid.cell_y_m);
    let rise_m = grid.elevation_m[to] as f64 - grid.elevation_m[from] as f64;
    let distance_m = horizontal.hypot(rise_m);
    let grade = rise_m.abs() / horizontal;
    let time_s = distance_m / model.flat_speed_m_s * (1.0 + model.slope_time_penalty * grade);
    Step { distance_m, time_s, rise_m }
}

fn build_leg(
    grid: &PlanningGrid,
    model: &TraversalModel,
    came_from: &[u32],
    goal: usize,
    cells_expanded: usize,
) -> Leg {
    let mut cells = vec![goal];
    let mut idx = goal;
    while came_from[idx] != u32::MAX {
        idx = came_from[idx] as usize;
        cells.push(idx);
    }
    cells.reverse();

    let mut leg = Leg {
        path: Vec::with_capacity(cells.len()),
        elevation_m: Vec::with_capacity(cells.len()),
        distance_m: 0.0,
        time_s: 0.0,
        ascent_m: 0.0,
        descent_m: 0.0,
        max_slope_deg: 0.0,
        cells_expanded,
    };
    for (i, &cell) in cells.iter().enumerate() {
        leg.path.push(grid.cell_center(cell % grid.width, cell / grid.width));
        leg.elevation_m.push(grid.elevation_m[cell]);
        leg.max_slope_deg = leg.max_slope_deg.max(grid.slope_deg[cell] as f64);
        if i > 0 {
            let s = step(grid, model, cells[i - 1], cell);
            leg.distance_m += s.distance_m;
            leg.time_s += s.time_s;
            if s.rise_m > 0.0 {
                leg.ascent_m += s.rise_m;
            } else {
                leg.descent_m -= s.rise_m;
            }
        }
    }
    leg
}

/// Per-step costs of a routed leg, in the same model as [`find_leg`].
///
/// Returns one entry per move between consecutive path points. `None` when a
/// point does not map back onto the lattice, which would mean a leg was built
/// for a different grid.
pub fn leg_step_metrics(
    grid: &PlanningGrid,
    model: &TraversalModel,
    leg: &Leg,
) -> Option<Vec<StepMetric>> {
    if leg.path.len() != leg.elevation_m.len() || leg.path.is_empty() {
        return None;
    }
    let mut cells = Vec::with_capacity(leg.path.len());
    for point in &leg.path {
        let (col, row) = grid.cell_of(*point)?;
        cells.push(grid.index(col, row));
    }
    let mut steps = Vec::with_capacity(cells.len().saturating_sub(1));
    for pair in cells.windows(2) {
        let s = step(grid, model, pair[0], pair[1]);
        steps.push(StepMetric { distance_m: s.distance_m, time_s: s.time_s });
    }
    Some(steps)
}

/// Whether `goal` can be reached from `start` through cells accepted by `allowed`.
fn connected(
    grid: &PlanningGrid,
    start: usize,
    goal: usize,
    allowed: impl Fn(usize) -> bool,
) -> bool {
    let mut seen = vec![false; grid.width * grid.height];
    let mut queue = VecDeque::from([start]);
    seen[start] = true;
    while let Some(idx) = queue.pop_front() {
        if idx == goal {
            return true;
        }
        for next in neighbours(grid, idx, &allowed) {
            if !seen[next] {
                seen[next] = true;
                queue.push_back(next);
            }
        }
    }
    false
}

impl Leg {
    /// The same leg walked the other way. Valid because the cost model is
    /// symmetric in the sign of the height change.
    pub fn reversed(&self) -> Leg {
        let mut leg = self.clone();
        leg.path.reverse();
        leg.elevation_m.reverse();
        std::mem::swap(&mut leg.ascent_m, &mut leg.descent_m);
        leg
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// Flat grid of `cell` m cells with every slope known and zero.
    pub fn flat(width: usize, height: usize, cell: f64) -> PlanningGrid {
        PlanningGrid {
            width,
            height,
            cell_x_m: cell,
            cell_y_m: cell,
            factor: 1,
            elevation_m: vec![0.0; width * height],
            slope_deg: vec![0.0; width * height],
        }
    }

    /// Centre of cell `(col, row)`.
    pub fn at(grid: &PlanningGrid, col: usize, row: usize) -> LocalPoint {
        grid.cell_center(col, row)
    }

    pub fn block(grid: &mut PlanningGrid, col: usize, row: usize) {
        let i = grid.index(col, row);
        grid.slope_deg[i] = 90.0;
    }

    pub fn unknown(grid: &mut PlanningGrid, col: usize, row: usize) {
        let i = grid.index(col, row);
        grid.slope_deg[i] = f32::NAN;
        grid.elevation_m[i] = f32::NAN;
    }

    pub const WALK: TraversalModel =
        TraversalModel { max_slope_deg: 20.0, flat_speed_m_s: 1.0, slope_time_penalty: 5.0 };
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    const SQRT2: f64 = std::f64::consts::SQRT_2;

    #[test]
    fn straight_leg_on_flat_ground_is_the_obvious_one() {
        let g = flat(7, 7, 1.0);
        let leg = find_leg(&g, &WALK, at(&g, 1, 3), at(&g, 5, 3), Search::AStar).unwrap();
        assert_eq!(leg.distance_m, 4.0);
        assert_eq!(leg.time_s, 4.0);
        assert_eq!(leg.path.len(), 5);
        assert_eq!(leg.path[0], at(&g, 1, 3));
        assert_eq!(leg.path[4], at(&g, 5, 3));
        assert_eq!((leg.ascent_m, leg.descent_m, leg.max_slope_deg), (0.0, 0.0, 0.0));
    }

    #[test]
    fn time_scales_with_flat_speed() {
        let g = flat(7, 7, 1.0);
        let slow = TraversalModel { flat_speed_m_s: 0.5, ..WALK };
        let leg = find_leg(&g, &slow, at(&g, 1, 3), at(&g, 5, 3), Search::AStar).unwrap();
        assert_eq!(leg.time_s, 8.0);
    }

    #[test]
    fn diagonal_moves_cost_the_diagonal_of_the_cell() {
        // 2 m × 1 m cells: three diagonal steps of √5 m each.
        let mut g = flat(6, 6, 1.0);
        g.cell_x_m = 2.0;
        let leg = find_leg(&g, &WALK, at(&g, 1, 1), at(&g, 4, 4), Search::AStar).unwrap();
        assert!((leg.distance_m - 3.0 * 5f64.sqrt()).abs() < 1e-9, "{}", leg.distance_m);
    }

    #[test]
    fn start_equal_to_goal_is_a_zero_length_leg() {
        let g = flat(5, 5, 1.0);
        let leg = find_leg(&g, &WALK, at(&g, 2, 2), at(&g, 2, 2), Search::AStar).unwrap();
        assert_eq!((leg.distance_m, leg.time_s, leg.path.len()), (0.0, 0.0, 1));
    }

    /// 7×7 flat grid with a blocked wall in column 3, rows 1–5; rows 0 and 6 open.
    fn walled() -> PlanningGrid {
        let mut g = flat(7, 7, 1.0);
        for row in 1..=5 {
            block(&mut g, 3, row);
        }
        g
    }

    #[test]
    fn leg_goes_around_a_blocked_wall_instead_of_through_it() {
        let g = walled();
        let leg = find_leg(&g, &WALK, at(&g, 1, 3), at(&g, 5, 3), Search::AStar).unwrap();
        // Straight through would be 4 m. Around either end of the wall, without
        // cutting its corner: 6 straight steps + 2 diagonals.
        assert!((leg.distance_m - (6.0 + 2.0 * SQRT2)).abs() < 1e-9, "{}", leg.distance_m);
        for p in &leg.path {
            let (col, row) = g.cell_of(*p).unwrap();
            assert!(!(col == 3 && (1..=5).contains(&row)), "path enters wall at {col},{row}");
        }
    }

    #[test]
    fn diagonal_may_not_squeeze_between_two_blocked_cells() {
        let mut g = flat(4, 4, 1.0);
        block(&mut g, 2, 1);
        block(&mut g, 1, 2);
        let leg = find_leg(&g, &WALK, at(&g, 1, 1), at(&g, 2, 2), Search::AStar).unwrap();
        // The direct diagonal (√2 m) is forbidden; the way round is 6 straight steps.
        assert_eq!(leg.distance_m, 6.0);
    }

    /// 6×5 ramp of 1 m cells rising 0.1 m per cell eastwards.
    fn ramp() -> PlanningGrid {
        let mut g = flat(6, 5, 1.0);
        for row in 0..5 {
            for col in 0..6 {
                let i = g.index(col, row);
                g.elevation_m[i] = 0.1 * col as f32;
                g.slope_deg[i] = 5.71;
            }
        }
        g
    }

    #[test]
    fn climbing_costs_surface_distance_and_the_slope_time_penalty() {
        let g = ramp();
        let leg = find_leg(&g, &WALK, at(&g, 1, 2), at(&g, 4, 2), Search::AStar).unwrap();
        // Three steps, each 1 m horizontal and 0.1 m up: s = √1.01 m,
        // time = s · (1 + 5 · 0.1).
        let step = 1.01f64.sqrt();
        assert!((leg.distance_m - 3.0 * step).abs() < 1e-6, "{}", leg.distance_m);
        assert!((leg.time_s - 3.0 * step * 1.5).abs() < 1e-6, "{}", leg.time_s);
        assert!((leg.ascent_m - 0.3).abs() < 1e-6 && leg.descent_m == 0.0);
        assert!((leg.max_slope_deg - 5.71).abs() < 1e-4);
    }

    #[test]
    fn descending_the_same_ramp_takes_the_same_time() {
        let g = ramp();
        let up = find_leg(&g, &WALK, at(&g, 1, 2), at(&g, 4, 2), Search::AStar).unwrap();
        let down = find_leg(&g, &WALK, at(&g, 4, 2), at(&g, 1, 2), Search::AStar).unwrap();
        assert!((up.time_s - down.time_s).abs() < 1e-9);
        assert!((down.descent_m - 0.3).abs() < 1e-6 && down.ascent_m == 0.0);
    }

    #[test]
    fn endpoint_outside_the_grid_is_reported_as_outside_coverage() {
        let g = flat(5, 5, 1.0);
        let err = find_leg(&g, &WALK, at(&g, 1, 1), LocalPoint::new(9.0, 1.0), Search::AStar)
            .unwrap_err();
        assert_eq!(err, RouteError::OutsideCoverage { endpoint: Endpoint::Goal });
    }

    #[test]
    fn endpoint_on_unknown_terrain_is_reported() {
        let mut g = flat(5, 5, 1.0);
        unknown(&mut g, 1, 1);
        let err =
            find_leg(&g, &WALK, at(&g, 1, 1), at(&g, 3, 3), Search::AStar).unwrap_err();
        assert_eq!(err, RouteError::UnknownTerrainAtEndpoint { endpoint: Endpoint::Start });
    }

    #[test]
    fn endpoint_steeper_than_the_scenario_limit_is_reported() {
        let mut g = flat(5, 5, 1.0);
        let i = g.index(3, 3);
        g.slope_deg[i] = 25.0;
        let err =
            find_leg(&g, &WALK, at(&g, 1, 1), at(&g, 3, 3), Search::AStar).unwrap_err();
        assert_eq!(
            err,
            RouteError::SlopeRuleAtEndpoint { endpoint: Endpoint::Goal, slope_deg: 25.0 }
        );
    }

    #[test]
    fn slope_exactly_at_the_limit_is_still_traversable() {
        let mut g = flat(5, 5, 1.0);
        for s in g.slope_deg.iter_mut() {
            *s = 20.0;
        }
        assert!(find_leg(&g, &WALK, at(&g, 1, 1), at(&g, 3, 3), Search::AStar).is_ok());
    }

    #[test]
    fn a_barrier_of_missing_data_is_reported_as_unknown_terrain_not_as_a_route() {
        let mut g = flat(7, 5, 1.0);
        for row in 0..5 {
            unknown(&mut g, 3, row);
        }
        let err =
            find_leg(&g, &WALK, at(&g, 1, 2), at(&g, 5, 2), Search::AStar).unwrap_err();
        assert_eq!(err, RouteError::RouteCrossesUnknownTerrain);
    }

    #[test]
    fn a_complete_barrier_of_steep_cells_is_reported_as_the_slope_rule() {
        let mut g = flat(7, 5, 1.0);
        for row in 0..5 {
            block(&mut g, 3, row);
        }
        let err =
            find_leg(&g, &WALK, at(&g, 1, 2), at(&g, 5, 2), Search::AStar).unwrap_err();
        assert_eq!(err, RouteError::BlockedBySlopeRule);
    }

    /// Deterministic bumpy terrain with scattered blocked and unknown cells.
    fn bumpy() -> PlanningGrid {
        let (w, h) = (40, 30);
        let mut g = flat(w, h, 4.0);
        g.cell_x_m = 3.9;
        let mut state: u32 = 12345;
        let mut next = || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 8) as f32 / (1u32 << 24) as f32
        };
        for i in 0..w * h {
            g.elevation_m[i] = next() * 3.0;
            let r = next();
            g.slope_deg[i] = if r < 0.12 { 35.0 } else { r * 15.0 };
            if next() < 0.03 {
                g.slope_deg[i] = f32::NAN;
                g.elevation_m[i] = f32::NAN;
            }
        }
        for (col, row) in [(2, 2), (37, 27), (5, 25), (33, 4), (20, 15)] {
            let i = g.index(col, row);
            g.slope_deg[i] = 1.0;
            g.elevation_m[i] = 1.0;
        }
        g
    }

    #[test]
    fn a_star_finds_the_same_minimum_time_as_dijkstra() {
        let g = bumpy();
        let pairs = [((2, 2), (37, 27)), ((5, 25), (33, 4)), ((20, 15), (2, 2)), ((33, 4), (37, 27))];
        for ((c0, r0), (c1, r1)) in pairs {
            let a = find_leg(&g, &WALK, at(&g, c0, r0), at(&g, c1, r1), Search::AStar).unwrap();
            let d = find_leg(&g, &WALK, at(&g, c0, r0), at(&g, c1, r1), Search::Dijkstra).unwrap();
            assert!((a.time_s - d.time_s).abs() < 1e-9, "A* {} vs Dijkstra {}", a.time_s, d.time_s);
            assert!(a.cells_expanded <= d.cells_expanded);
        }
    }

    #[test]
    fn every_step_of_a_path_is_between_traversable_neighbours() {
        let g = bumpy();
        let leg = find_leg(&g, &WALK, at(&g, 2, 2), at(&g, 37, 27), Search::AStar).unwrap();
        let cells: Vec<_> = leg.path.iter().map(|p| g.cell_of(*p).unwrap()).collect();
        for w in cells.windows(2) {
            let (dc, dr) = (w[1].0 as i64 - w[0].0 as i64, w[1].1 as i64 - w[0].1 as i64);
            assert!(dc.abs() <= 1 && dr.abs() <= 1 && (dc, dr) != (0, 0));
        }
        for (col, row) in cells {
            let s = g.slope_deg[g.index(col, row)];
            assert!(s <= 20.0, "cell {col},{row} has slope {s}");
        }
    }

    // ---- Temporary block overlays -------------------------------------------

    #[test]
    fn a_block_overlay_forces_the_same_detour_as_a_steep_wall() {
        let g = walled();
        let mut blocked = BlockOverlay::new(g.width, g.height);
        for row in 1..=5 {
            blocked.block_index(g.index(3, row));
        }
        let leg = find_leg_avoiding(
            &g,
            &WALK,
            at(&g, 1, 3),
            at(&g, 5, 3),
            Search::AStar,
            Some(&blocked),
        )
        .unwrap();
        assert!((leg.distance_m - (6.0 + 2.0 * SQRT2)).abs() < 1e-9);
        for p in &leg.path {
            let (col, row) = g.cell_of(*p).unwrap();
            assert!(!(col == 3 && (1..=5).contains(&row)), "path crosses blocked {col},{row}");
        }
    }

    #[test]
    fn the_underlying_terrain_is_unchanged_by_an_overlay() {
        let g = flat(7, 7, 1.0);
        let before = g.slope_deg.clone();
        let mut blocked = BlockOverlay::new(g.width, g.height);
        blocked.block_index(g.index(3, 3));
        let _ = find_leg_avoiding(
            &g,
            &WALK,
            at(&g, 1, 3),
            at(&g, 5, 3),
            Search::AStar,
            Some(&blocked),
        )
        .unwrap();
        assert_eq!(g.slope_deg, before);
        assert_eq!(g.elevation_m, vec![0.0; 49]);
    }

    #[test]
    fn a_blocked_endpoint_is_reported_without_a_search() {
        let g = flat(7, 7, 1.0);
        let mut blocked = BlockOverlay::new(g.width, g.height);
        blocked.block_index(g.index(1, 3));
        let error =
            find_leg_avoiding(&g, &WALK, at(&g, 1, 3), at(&g, 5, 3), Search::AStar, Some(&blocked))
                .unwrap_err();
        assert_eq!(error, RouteError::EndpointBlocked { endpoint: Endpoint::Start });
    }

    #[test]
    fn a_fully_cut_corridor_is_reported_as_a_slope_rule_block() {
        // The overlay closes the only gap the steep wall leaves open.
        let mut g = flat(7, 7, 1.0);
        for row in 1..=5 {
            block(&mut g, 3, row);
        }
        let mut blocked = BlockOverlay::new(g.width, g.height);
        blocked.block_index(g.index(3, 0));
        blocked.block_index(g.index(3, 6));
        let error =
            find_leg_avoiding(&g, &WALK, at(&g, 1, 3), at(&g, 5, 3), Search::AStar, Some(&blocked))
                .unwrap_err();
        assert_eq!(error, RouteError::BlockedBySlopeRule);
    }

    #[test]
    fn a_blocked_disc_covers_cells_around_its_centre_only() {
        let g = flat(21, 21, 1.0);
        let mut blocked = BlockOverlay::new(g.width, g.height);
        let center = at(&g, 10, 10);
        let added = blocked.block_disc(&g, center, 2.5).unwrap();
        // Cells whose centres lie within 2.5 m: the centre (1), axial
        // neighbours (4), diagonals (4), two cells out (4), knight moves (8).
        assert_eq!(added, 21);
        assert!(blocked.contains(g.index(10, 10)));
        assert!(blocked.contains(g.index(10, 8)));
        assert!(!blocked.contains(g.index(10, 7)));
        // Blocking the same disc again adds nothing.
        assert_eq!(blocked.block_disc(&g, center, 2.5).unwrap(), 0);
        assert_eq!(blocked.len(), 21);
    }

    #[test]
    fn invalid_disc_geometry_is_rejected() {
        let g = flat(9, 9, 1.0);
        let mut blocked = BlockOverlay::new(g.width, g.height);
        let center = at(&g, 4, 4);
        assert_eq!(blocked.block_disc(&g, center, 0.0), Err(OverlayError::InvalidRadius));
        assert_eq!(blocked.block_disc(&g, center, f64::NAN), Err(OverlayError::InvalidRadius));
        assert_eq!(
            blocked.block_disc(&g, LocalPoint::new(-1.0, 4.0), 2.0),
            Err(OverlayError::CenterOutsideCoverage)
        );
        let mut other = BlockOverlay::new(8, 8);
        assert_eq!(other.block_disc(&g, center, 2.0), Err(OverlayError::LatticeMismatch));
    }

    #[test]
    fn step_metrics_reproduce_the_leg_totals() {
        let g = bumpy();
        let leg = find_leg(&g, &WALK, at(&g, 2, 2), at(&g, 37, 27), Search::AStar).unwrap();
        let steps = leg_step_metrics(&g, &WALK, &leg).unwrap();
        assert_eq!(steps.len(), leg.path.len() - 1);
        let distance: f64 = steps.iter().map(|s| s.distance_m).sum();
        let time: f64 = steps.iter().map(|s| s.time_s).sum();
        assert!((distance - leg.distance_m).abs() < 1e-9);
        assert!((time - leg.time_s).abs() < 1e-9);
    }
}
