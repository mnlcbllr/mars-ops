# MARS-OPS Mars Dataset Pack — Jezero

This pack contains real archived NASA-mission Mars observations for the Jezero crater landing region only, with derivatives used by the app. It contains selected products and local crops, not complete mission archives. No app, simulated data, or live forecast is included.

## Start here

Open the optical, terrain, and thermal GeoTIFFs in QGIS or another GIS that supports planetary coordinate systems. Each map has an embedded Mars coordinate reference system. Do not assign an Earth CRS. The optical PNGs open in any image viewer. Open CSVs in a spreadsheet editor or Python. XML and LBL files are the archive labels with field names, units, and metadata. SOURCE-LINKS.csv lists the official file or product page for each included file.

| Folder | What is included | How to interpret it |
|---|---|---|
| 01-optical | MRO HiRISE orthorectified red-band image of Jezero, at about 1 m per pixel. GeoTIFF and quick-view PNG. | Crop from the mission product, not global or full-crater imagery. Credit NASA/JPL-Caltech/UArizona. |
| 02-thermal | Mars Odyssey THEMIS daytime and nighttime infrared (DIR/NIR) crops, 100 m per pixel, around Jezero. | Qualitative 8-bit brightness mosaics, not temperatures or forecasts. Credit NASA/USGS and the THEMIS team. |
| 03-spectral | MRO CRISM archived reflectance, FRT000047A3 for Jezero. A 64 × 64 pixel crop, 489 bands, 18 m map pixels, with source labels and wavelengths. | Unchanged reflectance values in a cropped GeoTIFF. Wavelengths are in nanometers and 65535 is NoData. The Jezero spectral crop is inside the HiRISE region. |
| 04-topographic | HiRISE stereo elevation GeoTIFF of Jezero at about 1 m per pixel. | Float32 elevations are in meters above the Mars areoid. This is the matching elevation grid for 01-optical. |
| 05-geophysical | NASA Goddard GMM-3 global free-air gravity anomalies, sampled to a 0.5° grid, in mGal. | Anomalies are deviations from a reference gravity model. The dataset is not suitable for meter-scale route safety. Every eighth row and column was selected from the source, with no interpolation. |
| 06-atmospheric | Perseverance MEDA sol 45 archive CSVs/labels for Jezero. | Historical measurements at the rover, not a forecast. The NASA PDS archive is linked below for scientific use. |
| 08-chemical | Perseverance PIXL oxide tables for Jezero, sol 125. | Rover sample measurements, not continuous maps. |

## Full-size products and source archives

The pack uses crops of large raster products. Individual source maps and cubes range from hundreds of MB to over 1 GB. Find exact full-size raster URLs and the original archive data URLs in SOURCE-LINKS.csv.

- [HiRISE Jezero](https://hirise.lpl.arizona.edu/dtm/ESP_023524_1985)
- [THEMIS catalog](https://registry.opendata.aws/nasa-usgs-themis-mosaics/)
- [CRISM archive](https://pds-geosciences.wustl.edu/missions/mro/crism.htm)
- [Mars Goddard GMM-3](https://pgda.gsfc.nasa.gov/products/57)
- [Jezero MEDA archive](https://pds-atmospheres.nmsu.edu/data_and_services/atmospheres_data/PERSEVERANCE/meda.html)
- [Jezero PIXL PMC Oxides archive](https://pds-geosciences.wustl.edu/m2020/urn-nasa-pds-mars2020_pixl/data_oxides_pmc/)
