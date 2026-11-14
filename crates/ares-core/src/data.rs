//! Packaged dataset: manifest, provenance records and raster loading.
//!
//! A dataset directory holds `manifest.json` plus the files it names. Nothing
//! is trusted on the manifest's word: every layer file is hashed on open and
//! compared with the recorded SHA-256, and a dataset is called *real data*
//! only if every layer says it was verified against its archive source.

use crate::geo::GridGeoreference;
use crate::planning::{MissionScenario, ScientificSite};
use crate::provenance::EvidenceKind;
use crate::resources::{ResourceBudget, ResourceModel};
use crate::terrain::Raster;
use crate::LocalPoint;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MANIFEST_FILE: &str = "manifest.json";
/// Base position and candidate science sites packaged with the dataset.
pub const TARGETS_FILE: &str = "targets.json";
/// Default resource budget and model coefficients packaged with the dataset.
pub const ASSUMPTIONS_FILE: &str = "assumptions.json";
/// Largest file the loader will read into memory. The packaged layers are
/// about 17 MB; this bounds what a damaged dataset directory can allocate.
pub const MAX_FILE_BYTES: u64 = 1 << 30;

/// A dataset found under a datasets root directory.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DatasetSummary {
    /// The directory name; what [`dataset_dir`] accepts.
    pub dataset_id: String,
    pub display_name: String,
    pub region_name: String,
}

/// Contents of [`TARGETS_FILE`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Targets {
    pub base: LocalPoint,
    pub base_note: String,
    pub sites: Vec<ScientificSite>,
}

/// Contents of [`ASSUMPTIONS_FILE`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Assumptions {
    pub budget: ResourceBudget,
    pub model: ResourceModel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LayerKind {
    /// Numeric elevation, little-endian `f32`, row-major, north to south.
    Elevation,
    /// Display imagery (PNG). Not a source of heights.
    Imagery,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct BBoxDeg {
    pub lat_min: f64,
    pub lat_max: f64,
    pub lon_east_min: f64,
    pub lon_east_max: f64,
}

/// Provenance of one layer. Optional fields are `None` when the source does
/// not state them; they are never filled with guesses.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LayerRecord {
    pub id: String,
    pub display_name: String,
    pub kind: LayerKind,
    /// File name inside the dataset directory.
    pub file: String,
    pub origin_type: EvidenceKind,
    pub provider: String,
    pub instrument: String,
    pub product_id: String,
    pub source_url: String,
    pub license_and_credit: String,
    pub retrieved_utc: Option<String>,
    pub observation_date: Option<String>,
    pub source_crs: Option<String>,
    pub output_crs: Option<String>,
    pub vertical_datum: Option<String>,
    /// `[east–west, north–south]` ground size of a cell, metres.
    pub pixel_size_m: Option<[f64; 2]>,
    /// Extent of the whole source product.
    pub bbox_original: Option<BBoxDeg>,
    /// `[x_min, y_min, x_max, y_max]` of the packaged region in the source projection, metres.
    pub bbox_projected_m: Option<[f64; 4]>,
    pub nodata_value: Option<f64>,
    pub sha256_source: Option<String>,
    pub sha256_derived: String,
    pub processing_steps: Vec<String>,
    pub quality_notes: Vec<String>,
    pub is_real_source_verified: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub dataset_id: String,
    pub display_name: String,
    pub body: String,
    pub region_name: String,
    pub generated_utc: Option<String>,
    pub georeference: GridGeoreference,
    /// Extent of the packaged region.
    pub roi_bbox: BBoxDeg,
    pub layers: Vec<LayerRecord>,
}

#[derive(Debug, thiserror::Error)]
pub enum DataError {
    #[error("cannot read {path}: {message}")]
    Io { path: String, message: String },
    #[error("manifest does not match the expected schema: {0}")]
    ManifestParse(String),
    #[error("UnsupportedProjection: {0}; only EQUIRECTANGULAR grids are supported")]
    UnsupportedProjection(String),
    #[error("MissingNoDataMetadata: layer '{0}' does not declare its no-data value")]
    MissingNoDataMetadata(String),
    #[error("MissingLayer: the dataset has no {0} layer")]
    MissingLayer(String),
    #[error("ChecksumMismatch: {file} has SHA-256 {actual} but the manifest records {expected}")]
    ChecksumMismatch { file: String, expected: String, actual: String },
    #[error("DataAlignmentFailure: {0}")]
    DataAlignmentFailure(String),
    #[error("FileTooLarge: {path} is {bytes} bytes; the loader reads at most {limit}")]
    FileTooLarge { path: String, bytes: u64, limit: u64 },
    #[error("InvalidDatasetId: '{0}' is not a dataset name (letters, digits, '-' and '_' only)")]
    InvalidDatasetId(String),
}

/// Read a whole file, refusing anything larger than `limit` bytes.
fn read_capped(path: &Path, limit: u64) -> Result<Vec<u8>, DataError> {
    use std::io::Read;
    let io = |e: std::io::Error| DataError::Io { path: path.display().to_string(), message: e.to_string() };
    let too_large = |bytes| DataError::FileTooLarge { path: path.display().to_string(), bytes, limit };

    let file = std::fs::File::open(path).map_err(io)?;
    let size = file.metadata().map_err(io)?.len();
    if size > limit {
        return Err(too_large(size));
    }
    // Read through a bound as well: the file may grow after the size check.
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(limit.saturating_add(1)).read_to_end(&mut bytes).map_err(io)?;
    if bytes.len() as u64 > limit {
        return Err(too_large(bytes.len() as u64));
    }
    Ok(bytes)
}

/// Read a layer's file from `dir` and check it against the manifest's hash.
fn read_layer_file(dir: &Path, layer: &LayerRecord) -> Result<Vec<u8>, DataError> {
    let name = Path::new(&layer.file);
    if name.components().count() != 1 || name.file_name().is_none() {
        return Err(DataError::ManifestParse(format!(
            "layer file '{}' must be a plain file name inside the dataset directory",
            layer.file
        )));
    }
    let bytes = read_capped(&dir.join(name), MAX_FILE_BYTES)?;
    let actual = sha256_hex(&bytes);
    if !actual.eq_ignore_ascii_case(&layer.sha256_derived) {
        return Err(DataError::ChecksumMismatch {
            file: layer.file.clone(),
            expected: layer.sha256_derived.clone(),
            actual,
        });
    }
    Ok(bytes)
}

/// Directory of dataset `dataset_id` under `root`. The id must be a plain
/// name, so a caller-supplied id can never address a path outside `root`.
pub fn dataset_dir(root: &Path, dataset_id: &str) -> Result<PathBuf, DataError> {
    let plain = !dataset_id.is_empty()
        && dataset_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !plain {
        return Err(DataError::InvalidDatasetId(dataset_id.to_string()));
    }
    Ok(root.join(dataset_id))
}

/// Datasets under `root`: sub-directories with a valid name and a readable
/// manifest, sorted by id. An unreadable root is simply empty.
pub fn find_datasets(root: &Path) -> Vec<DatasetSummary> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<DatasetSummary> = entries
        .flatten()
        .filter_map(|entry| {
            let dataset_id = entry.file_name().into_string().ok()?;
            let dir = dataset_dir(root, &dataset_id).ok()?;
            let bytes = read_capped(&dir.join(MANIFEST_FILE), MAX_FILE_BYTES).ok()?;
            let manifest: Manifest = serde_json::from_slice(&bytes).ok()?;
            Some(DatasetSummary {
                dataset_id,
                display_name: manifest.display_name,
                region_name: manifest.region_name,
            })
        })
        .collect();
    found.sort_by(|a, b| a.dataset_id.cmp(&b.dataset_id));
    found
}

/// An opened, checksum-verified dataset.
#[derive(Clone, Debug)]
pub struct Dataset {
    pub dir: PathBuf,
    pub manifest: Manifest,
    /// SHA-256 of `manifest.json` itself, recorded with every mission result.
    pub manifest_sha256: String,
    pub elevation: Raster,
}

/// Lower-case hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

impl Dataset {
    /// Open and verify the dataset in `dir`.
    pub fn open(dir: &Path) -> Result<Dataset, DataError> {
        let manifest_bytes = read_capped(&dir.join(MANIFEST_FILE), MAX_FILE_BYTES)?;
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| DataError::ManifestParse(e.to_string()))?;

        let geo = &manifest.georeference;
        if geo.projection != "EQUIRECTANGULAR" {
            return Err(DataError::UnsupportedProjection(geo.projection.clone()));
        }
        // The manifest's ground cell size must agree with its own projection
        // parameters, or distances and slopes would be silently wrong.
        let agrees = |stated: f64, implied: f64| (stated - implied).abs() <= 1e-3 * implied.abs();
        if !agrees(geo.cell_size_x_m, geo.implied_cell_size_x_m())
            || !agrees(geo.cell_size_y_m, geo.map_scale_m_per_px)
        {
            return Err(DataError::DataAlignmentFailure(format!(
                "cell size {} × {} m does not match the projection, which implies {:.6} × {:.6} m",
                geo.cell_size_x_m,
                geo.cell_size_y_m,
                geo.implied_cell_size_x_m(),
                geo.map_scale_m_per_px
            )));
        }

        // Verify every layer file before using any of them.
        let mut elevation_bytes = None;
        for layer in &manifest.layers {
            let bytes = read_layer_file(dir, layer)?;
            if layer.kind == LayerKind::Elevation && elevation_bytes.is_none() {
                elevation_bytes = Some((layer, bytes));
            }
        }

        let (layer, bytes) =
            elevation_bytes.ok_or_else(|| DataError::MissingLayer("elevation".into()))?;
        let nodata = layer
            .nodata_value
            .ok_or_else(|| DataError::MissingNoDataMetadata(layer.id.clone()))?;
        let elevation = Raster::from_f32le_bytes(
            &bytes,
            geo.width,
            geo.height,
            geo.cell_size_x_m,
            geo.cell_size_y_m,
            nodata as f32,
        )
        .map_err(|e| DataError::DataAlignmentFailure(e.to_string()))?;

        Ok(Dataset {
            dir: dir.to_path_buf(),
            manifest_sha256: sha256_hex(&manifest_bytes),
            manifest,
            elevation,
        })
    }

    pub fn layer(&self, kind: LayerKind) -> Option<&LayerRecord> {
        self.manifest.layers.iter().find(|l| l.kind == kind)
    }

    /// Bytes of the first layer of `kind`, read again and re-checked against
    /// the manifest hash, so a file changed after `open` is never served.
    pub fn read_layer_verified(&self, kind: LayerKind) -> Result<Vec<u8>, DataError> {
        let layer = self
            .layer(kind)
            .ok_or_else(|| DataError::MissingLayer(format!("{kind:?}").to_lowercase()))?;
        read_layer_file(&self.dir, layer)
    }

    /// Path of the display imagery file, if the dataset has one.
    pub fn imagery_path(&self) -> Option<PathBuf> {
        self.layer(LayerKind::Imagery).map(|l| self.dir.join(&l.file))
    }

    /// The scenario packaged with the dataset: its targets and default assumptions.
    pub fn default_scenario(&self) -> Result<MissionScenario, DataError> {
        fn load<T: serde::de::DeserializeOwned>(path: PathBuf) -> Result<T, DataError> {
            let bytes = read_capped(&path, MAX_FILE_BYTES)?;
            serde_json::from_slice(&bytes)
                .map_err(|e| DataError::ManifestParse(format!("{}: {e}", path.display())))
        }
        let targets: Targets = load(self.dir.join(TARGETS_FILE))?;
        let assumptions: Assumptions = load(self.dir.join(ASSUMPTIONS_FILE))?;
        Ok(MissionScenario {
            schema_version: 1,
            name: format!("{} — packaged demo scenario", self.manifest.display_name),
            dataset_id: self.manifest.dataset_id.clone(),
            base: targets.base,
            sites: targets.sites,
            budget: assumptions.budget,
            model: assumptions.model,
        })
    }

    /// True only if every layer is recorded as verified against an archive
    /// source (with that source's hash) and none is synthetic.
    pub fn is_real_data_verified(&self) -> bool {
        !self.manifest.layers.is_empty()
            && self.manifest.layers.iter().all(|l| {
                l.is_real_source_verified
                    && l.sha256_source.is_some()
                    && l.origin_type != EvidenceKind::Synthetic
            })
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::fs;

    pub const NODATA: f32 = -3.402_822_6e38;

    pub fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ares-data-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub fn f32_bytes(values: &[f32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    pub fn layer(kind: LayerKind, file: &str, sha: &str, verified: bool) -> LayerRecord {
        LayerRecord {
            id: format!("{file}-layer"),
            display_name: file.into(),
            kind,
            file: file.into(),
            origin_type: if verified { EvidenceKind::Derived } else { EvidenceKind::Synthetic },
            provider: "test".into(),
            instrument: "test".into(),
            product_id: "TEST_PRODUCT".into(),
            source_url: "https://example.invalid/".into(),
            license_and_credit: "test".into(),
            retrieved_utc: None,
            observation_date: None,
            source_crs: None,
            output_crs: None,
            vertical_datum: None,
            pixel_size_m: Some([1.0, 1.0]),
            bbox_original: None,
            bbox_projected_m: None,
            nodata_value: Some(NODATA as f64),
            sha256_source: verified.then(|| "ab".repeat(32)),
            sha256_derived: sha.into(),
            processing_steps: vec![],
            quality_notes: vec![],
            is_real_source_verified: verified,
        }
    }

    /// Manifest of a `width × height` grid of 1 m cells at the equator.
    pub fn manifest(width: usize, height: usize, layers: Vec<LayerRecord>) -> Manifest {
        Manifest {
            schema_version: 1,
            dataset_id: "tiny".into(),
            display_name: "Tiny".into(),
            body: "Mars".into(),
            region_name: "Nowhere".into(),
            generated_utc: None,
            georeference: GridGeoreference {
                projection: "EQUIRECTANGULAR".into(),
                radius_m: 3_394_839.8,
                center_latitude_deg: 0.0,
                center_longitude_deg: 77.0,
                map_scale_m_per_px: 1.0,
                roi_x_min_m: 0.0,
                roi_y_max_m: height as f64,
                width,
                height,
                cell_size_x_m: 1.0,
                cell_size_y_m: 1.0,
            },
            roi_bbox: BBoxDeg { lat_min: 0.0, lat_max: 0.1, lon_east_min: 77.0, lon_east_max: 77.1 },
            layers,
        }
    }

    /// Write `values` (row 0 = north; use [`NODATA`] for missing cells) as a
    /// dataset in `dir` with a correct elevation layer; `edit` may then break it.
    pub fn write_raster_dataset(
        dir: &Path,
        width: usize,
        height: usize,
        values: &[f32],
        verified: bool,
        edit: impl FnOnce(&mut Manifest),
    ) {
        fs::create_dir_all(dir).unwrap();
        let bytes = f32_bytes(values);
        fs::write(dir.join("elevation.bin"), &bytes).unwrap();
        let elevation = layer(LayerKind::Elevation, "elevation.bin", &sha256_hex(&bytes), verified);
        let mut m = manifest(width, height, vec![elevation]);
        edit(&mut m);
        fs::write(dir.join(MANIFEST_FILE), serde_json::to_string_pretty(&m).unwrap()).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::fs;

    /// 3 wide × 2 tall, the last cell missing.
    const TINY: [f32; 6] = [10.0, 20.0, 30.0, 40.0, 50.0, NODATA];

    fn write_dataset(tag: &str, verified: bool, edit: impl FnOnce(&mut Manifest)) -> PathBuf {
        let dir = temp_dir(tag);
        write_raster_dataset(&dir, 3, 2, &TINY, verified, edit);
        dir
    }

    #[test]
    fn a_file_over_the_size_limit_is_refused() {
        let path = temp_dir("capped").join("five.bin");
        fs::write(&path, b"12345").unwrap();
        assert_eq!(read_capped(&path, 5).unwrap(), b"12345");
        assert!(matches!(
            read_capped(&path, 4),
            Err(DataError::FileTooLarge { bytes: 5, limit: 4, .. })
        ));
    }

    #[test]
    fn dataset_ids_that_are_not_plain_names_are_refused() {
        let root = Path::new("/data/root");
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", "/etc", "a b", "é"] {
            assert!(
                matches!(dataset_dir(root, bad), Err(DataError::InvalidDatasetId(_))),
                "'{bad}' must be refused"
            );
        }
        assert_eq!(dataset_dir(root, "jezero-small").unwrap(), root.join("jezero-small"));
        assert_eq!(dataset_dir(root, "A_1").unwrap(), root.join("A_1"));
    }

    #[test]
    fn find_datasets_lists_only_named_directories_with_a_readable_manifest() {
        let root = temp_dir("root");
        write_raster_dataset(&root.join("zeta"), 3, 2, &TINY, true, |_| {});
        write_raster_dataset(&root.join("alpha"), 3, 2, &TINY, true, |m| m.display_name = "Alpha".into());
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::create_dir_all(root.join("garbage")).unwrap();
        fs::write(root.join("garbage").join(MANIFEST_FILE), "{ not json").unwrap();
        write_raster_dataset(&root.join("bad name"), 3, 2, &TINY, true, |_| {});
        fs::write(root.join("file.txt"), "not a directory").unwrap();

        let summary = |id: &str, name: &str| DatasetSummary {
            dataset_id: id.into(),
            display_name: name.into(),
            region_name: "Nowhere".into(),
        };
        assert_eq!(find_datasets(&root), [summary("alpha", "Alpha"), summary("zeta", "Tiny")]);
        assert_eq!(find_datasets(&root.join("does-not-exist")), []);
    }

    #[test]
    fn a_layer_is_served_only_while_its_hash_still_matches() {
        let png = b"stand-in imagery bytes".to_vec();
        let dir = temp_dir("serve");
        fs::write(dir.join("ortho.png"), &png).unwrap();
        write_raster_dataset(&dir, 3, 2, &TINY, true, |m| {
            m.layers.push(layer(LayerKind::Imagery, "ortho.png", &sha256_hex(&png), true));
        });
        let ds = Dataset::open(&dir).unwrap();
        assert_eq!(ds.read_layer_verified(LayerKind::Imagery).unwrap(), png);
        assert_eq!(ds.read_layer_verified(LayerKind::Elevation).unwrap(), f32_bytes(&TINY));

        fs::write(dir.join("ortho.png"), b"swapped after the dataset was opened").unwrap();
        assert!(matches!(
            ds.read_layer_verified(LayerKind::Imagery),
            Err(DataError::ChecksumMismatch { .. })
        ));
    }

    #[test]
    fn asking_for_a_layer_the_dataset_lacks_is_missing_layer() {
        let ds = Dataset::open(&write_dataset("nolayerkind", true, |_| {})).unwrap();
        assert!(matches!(ds.read_layer_verified(LayerKind::Imagery), Err(DataError::MissingLayer(_))));
    }

    #[test]
    fn sha256_matches_the_published_test_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn opens_a_valid_dataset_and_reads_exact_elevations() {
        let dir = write_dataset("valid", true, |_| {});
        let ds = Dataset::open(&dir).unwrap();
        assert_eq!((ds.elevation.width, ds.elevation.height), (3, 2));
        assert_eq!(&ds.elevation.data[..5], &[10.0, 20.0, 30.0, 40.0, 50.0]);
        assert!(ds.elevation.data[5].is_nan());
        assert_eq!(ds.manifest_sha256.len(), 64);
    }

    #[test]
    fn a_changed_byte_in_the_raster_is_a_checksum_mismatch() {
        let dir = write_dataset("tampered", true, |_| {});
        let mut bytes = fs::read(dir.join("elevation.bin")).unwrap();
        bytes[0] ^= 1;
        fs::write(dir.join("elevation.bin"), bytes).unwrap();
        assert!(matches!(Dataset::open(&dir), Err(DataError::ChecksumMismatch { .. })));
    }

    #[test]
    fn elevation_without_a_nodata_value_is_rejected() {
        let dir = write_dataset("nonodata", true, |m| m.layers[0].nodata_value = None);
        assert!(matches!(Dataset::open(&dir), Err(DataError::MissingNoDataMetadata(_))));
    }

    #[test]
    fn unknown_projection_is_rejected() {
        let dir = write_dataset("proj", true, |m| m.georeference.projection = "POLAR STEREOGRAPHIC".into());
        assert!(matches!(Dataset::open(&dir), Err(DataError::UnsupportedProjection(_))));
    }

    #[test]
    fn raster_size_that_disagrees_with_the_grid_is_an_alignment_failure() {
        let dir = write_dataset("size", true, |m| m.georeference.width = 4);
        assert!(matches!(Dataset::open(&dir), Err(DataError::DataAlignmentFailure(_))));
    }

    #[test]
    fn cell_width_that_disagrees_with_the_projection_is_an_alignment_failure() {
        // At the equator with true scale at the equator a 1 m pixel is 1 m wide, not 2 m.
        let dir = write_dataset("cell", true, |m| m.georeference.cell_size_x_m = 2.0);
        assert!(matches!(Dataset::open(&dir), Err(DataError::DataAlignmentFailure(_))));
    }

    #[test]
    fn dataset_without_an_elevation_layer_is_rejected() {
        let dir = write_dataset("nolayer", true, |m| m.layers.clear());
        assert!(matches!(Dataset::open(&dir), Err(DataError::MissingLayer(_))));
    }

    #[test]
    fn missing_manifest_is_an_io_error_and_garbage_is_a_parse_error() {
        let dir = temp_dir("empty");
        assert!(matches!(Dataset::open(&dir), Err(DataError::Io { .. })));
        fs::write(dir.join(MANIFEST_FILE), "{ not json").unwrap();
        assert!(matches!(Dataset::open(&dir), Err(DataError::ManifestParse(_))));
    }

    #[test]
    fn layer_file_may_not_escape_the_dataset_directory() {
        let dir = write_dataset("escape", true, |m| m.layers[0].file = "../elevation.bin".into());
        assert!(matches!(Dataset::open(&dir), Err(DataError::ManifestParse(_))));
    }

    #[test]
    fn only_fully_verified_layers_count_as_real_data() {
        let real = Dataset::open(&write_dataset("real", true, |_| {})).unwrap();
        assert!(real.is_real_data_verified());

        let synthetic = Dataset::open(&write_dataset("synth", false, |_| {})).unwrap();
        assert!(!synthetic.is_real_data_verified());

        let no_source_hash =
            Dataset::open(&write_dataset("nohash", true, |m| m.layers[0].sha256_source = None)).unwrap();
        assert!(!no_source_hash.is_real_data_verified());
    }

    #[test]
    fn default_scenario_combines_packaged_targets_and_assumptions() {
        use crate::resources::test_support::{bare_model, time_only};
        let dir = write_dataset("scenario", true, |_| {});
        let targets = Targets {
            base: LocalPoint::new(1.5, 0.5),
            base_note: "test".into(),
            sites: vec![ScientificSite {
                id: "A".into(),
                name: "Site A".into(),
                position: LocalPoint::new(0.5, 1.5),
                science_rationale: "test".into(),
                source_product_ids: vec!["TEST_PRODUCT".into()],
                evidence_kind: EvidenceKind::UserDefined,
                activity_min_s: 60.0,
                activity_max_s: 120.0,
                activity_power_w: 5.0,
                preference_weight: 2.0,
                required: false,
            }],
        };
        let assumptions = Assumptions { budget: time_only(3600.0, 600.0), model: bare_model() };
        fs::write(dir.join(TARGETS_FILE), serde_json::to_string(&targets).unwrap()).unwrap();
        fs::write(dir.join(ASSUMPTIONS_FILE), serde_json::to_string(&assumptions).unwrap()).unwrap();

        let scenario = Dataset::open(&dir).unwrap().default_scenario().unwrap();
        assert_eq!(scenario.dataset_id, "tiny");
        assert_eq!(scenario.base, LocalPoint::new(1.5, 0.5));
        assert_eq!(scenario.sites, targets.sites);
        assert_eq!(scenario.budget.eva_reserve_s, 600.0);
        assert_eq!(scenario.model, assumptions.model);
    }

    #[test]
    fn default_scenario_reports_missing_or_malformed_files() {
        let dir = write_dataset("noscenario", true, |_| {});
        let ds = Dataset::open(&dir).unwrap();
        assert!(matches!(ds.default_scenario(), Err(DataError::Io { .. })));
        fs::write(dir.join(TARGETS_FILE), "[]").unwrap();
        assert!(matches!(ds.default_scenario(), Err(DataError::ManifestParse(_))));
    }

    #[test]
    fn imagery_layer_is_checksummed_too() {
        let dir = write_dataset("imagery", true, |m| {
            m.layers.push(layer(LayerKind::Imagery, "ortho.png", &"00".repeat(32), true));
        });
        fs::write(dir.join("ortho.png"), b"not really a png").unwrap();
        assert!(matches!(Dataset::open(&dir), Err(DataError::ChecksumMismatch { .. })));
    }
}
