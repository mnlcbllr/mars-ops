//! Epistemic status of every number the application shows.

use serde::{Deserialize, Serialize};

/// How a value came to exist. Shown next to data layers, sites and coefficients.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvidenceKind {
    /// Recorded by an instrument (e.g. an orbital image).
    Observed,
    /// Computed from observations by a documented method (e.g. a stereo DTM, slope).
    Derived,
    /// Output of a declared model with assumed coefficients.
    Modeled,
    /// Chosen by the mission designer; not a measurement.
    UserDefined,
    /// Invented for tests or demos. Never shown as real data.
    Synthetic,
}

/// A model coefficient together with where it came from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Coefficient {
    pub value: f64,
    pub unit: String,
    pub source_type: EvidenceKind,
    pub citation_or_assumption: String,
    /// Plausible range for sensitivity studies, if one has been declared.
    pub range: Option<[f64; 2]>,
    pub version: u32,
}
