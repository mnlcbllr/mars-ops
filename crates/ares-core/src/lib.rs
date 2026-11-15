//! HYDE scientific core.
//!
//! Everything that makes a scientific claim lives here, independent of the
//! desktop shell: reading packaged Mars rasters, terrain metrics, leg routing,
//! resource accounting and mission planning.
//!
//! Local coordinates are metres in the packaged region's own frame: origin at
//! the south-west corner, `x_m` east, `y_m` north. Never use raw latitude /
//! longitude differences as distances.

pub mod data;
pub mod contingency;
pub mod mission;
pub mod benchmark;
pub mod simulation_events;
pub mod geo;
pub mod inspect;
pub mod mission_state;
pub mod planning;
pub mod provenance;
pub mod replan;
pub mod report;
pub mod resources;
pub mod route;
pub mod session;
pub mod terrain;

#[cfg(test)]
mod mission_tests;

use serde::{Deserialize, Serialize};

/// A position in the packaged region's local metric frame.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LocalPoint {
    pub x_m: f64,
    pub y_m: f64,
}

impl LocalPoint {
    pub fn new(x_m: f64, y_m: f64) -> Self {
        Self { x_m, y_m }
    }
}
