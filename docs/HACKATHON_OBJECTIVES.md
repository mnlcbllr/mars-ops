# HYDE challenge coverage

| Challenge objective | What to demonstrate |
| --- | --- |
| Map, tool or interface for an astronaut on Mars | Start at the offline Mars globe, zoom into Jezero, and run the mission without leaving the globe. Inspect the same route in the separate 2D and local 3D views. |
| Science goal and exploration location | Compare the visible layering and surface textures of light-toned mounds and reference terrain on the Jezero crater floor east of the western delta. Show a proposed photography or field-notes task on each stop card. |
| Several kinds of data combined for navigation and context | Use the registered HiRISE optical base, derived stereo topography, and USGS regional geology. Geology can be overlaid in both views. Elevation drives slope calculations. Slope is derived from topography and is not counted as a separate data source. |
| Safety and suited-crew mobility | Show steep and unknown cells, modeled maximum slope, EVA time, energy and oxygen assumptions, return-to-base feasibility and reserves. Lower the slope limit, run again and inspect exclusions. These are model constraints and not NASA-approved limits or certified safety. |
| Route visual | Use Play route on globe to follow the real planned geometry through numbered stops and back to base. The route is inspired by NASA's annotated Curiosity example at Mount Sharp, but uses Jezero data and a different mission. |

**Demo order:** select Jezero on Mars globe → turn on Geology → run the packaged scenario → play the route on the globe →
click a numbered stop → show the return leg and reserve checks → lower the slope
limit to 10° and rerun. The stricter example removes the mound summit stop in the
real-dataset regression test.

The geology source has regional scale (1:75,000). Use it to describe the
mapped context, not to infer precise contacts, composition or walkability.
Small hazards and actual radiation are outside the prototype model.
