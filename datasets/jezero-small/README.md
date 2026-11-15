# HYDE Mars Dataset Pack

This ZIP contains real archived NASA-mission Mars observations and derivatives, covering all eight requested data types. It contains selected products and local crops, not complete mission archives. No app, simulated data, or live forecast is included.

## Start here

Open the optical, terrain, and thermal GeoTIFFs in QGIS or another GIS that supports planetary coordinate systems. Each map has an embedded Mars coordinate reference system. Do not assign an Earth CRS. The optical PNGs open in any image viewer. Open CSVs in a spreadsheet editor or Python. XML and LBL files are the archive labels with field names, units, and metadata. SOURCE-LINKS.csv lists the official file or product page for each included file.

| Folder | What is included | How to interpret it |
|---|---|---|
| 01-optical | MRO HiRISE orthorectified red-band images of Jezero and Gale, at about 1 m per pixel. GeoTIFFs and quick-view PNGs. | Crops from the mission products, not global or full-crater imagery. Credit NASA/JPL-Caltech/UArizona. |
| 02-thermal | Mars Odyssey THEMIS daytime and nighttime infrared (DIR/NIR) crops, 100 m per pixel, around both sites. | Qualitative 8-bit brightness mosaics, not temperatures or forecasts. Credit NASA/USGS and the THEMIS team. |
| 03-spectral | MRO CRISM archived reflectance, FRT000047A3 for Jezero and FRT0002037A for Gale. A 64 × 64 pixel crop per site, 489 bands, 18 m map pixels, with source labels and wavelengths. | Unchanged reflectance values in cropped GeoTIFFs. Wavelengths are in nanometers and 65535 is NoData. The Jezero spectral crop is inside the HiRISE region. The Gale spectral crop is in the crater, north of the included HiRISE crop, so do not treat the two as overlapping. |
| 04-topographic | HiRISE stereo elevation GeoTIFFs of Jezero and Gale at about 1 m per pixel. | Float32 elevations are in meters above the Mars areoid. These are the matching elevation grids for 01-optical. |
| 05-geophysical | NASA Goddard GMM-3 global free-air gravity anomalies, sampled to a 0.5° grid, in mGal. | Anomalies are deviations from a reference gravity model. The dataset is not suitable for meter-scale route safety. Every eighth row and column was selected from the source, with no interpolation. |
| 06-atmospheric | Perseverance MEDA sol 45 archive CSVs/labels for Jezero. Curiosity REMS daily weather-feed snapshot for Gale, as NASA JSON and a sorted CSV. | Historical measurements at the rover, not a forecast. The Gale weather feed is an outreach summary, and '--' means a missing value. The NASA PDS archive is linked below for scientific use. |
| 07-radiation | Curiosity RAD surface RDR for Gale, sol 874, in original TXT and LBL, plus a CSV of 38 detector B and E dose-rate pairs. | Dose rates are in microgray/hour in the instrument detectors. Not equivalent to astronaut dose and not a radiation map of Jezero or Gale. |
| 08-chemical | Perseverance PIXL oxide tables for Jezero, sol 125. Curiosity APXS sol 46 oxide product and APXS target/composition tables for Gale, sols 0–2301. | Rover sample measurements, not continuous maps. The larger Gale APXS supplement is in its original encoding. If UTF-8 fails, open as Latin-1. |

## Full-size products and source archives

The ZIP uses crops of large raster products. Individual source maps and cubes range from hundreds of MB to over 1 GB. Find exact full-size raster URLs and the original archive data URLs in SOURCE-LINKS.csv.

- [HiRISE Jezero](https://hirise.lpl.arizona.edu/dtm/ESP_023524_1985)
- [HiRISE Gale](https://www.uahirise.org/dtm/dtm.php?ID=ESP_040770_1755)
- [THEMIS catalog](https://registry.opendata.aws/nasa-usgs-themis-mosaics/)
- [CRISM archive](https://pds-geosciences.wustl.edu/missions/mro/crism.htm)
- [Mars Goddard GMM-3](https://pgda.gsfc.nasa.gov/products/57)
- [Jezero MEDA archive](https://pds-atmospheres.nmsu.edu/data_and_services/atmospheres_data/PERSEVERANCE/meda.html)
- [Gale REMS PDS archive](https://pds-atmospheres.nmsu.edu/data_and_services/atmospheres_data/MARS/curiosity/rems.html)
- [Gale radiation PDS archive](https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/)
- [Jezero PIXL PMC Oxides archive](https://pds-geosciences.wustl.edu/m2020/urn-nasa-pds-mars2020_pixl/data_oxides_pmc/)
- [Gale APXS archive](https://pds-geosciences.wustl.edu/missions/msl/apxs.htm)
