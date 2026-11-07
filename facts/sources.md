# Sources

Every `source_ids` entry in the JSON bundles resolves to a heading here. Headings are
the stable ids. When adding a source: primary paper or archive first, press release
only as a secondary pointer. Record the date you last verified the URL.

Legend for *use*: **F** = fact source (numbers come from it), **D** = data archive the
engine should ingest, **R** = reference reading for the design agent (architectures,
plans, critiques), not a source of facts.

---

## nssdc-mars-factsheet
NASA NSSDCA Planetary Fact Sheet: Mars. D. R. Williams, NASA GSFC. Last updated 19 May 2025.
https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html
Use: **F** for bulk and orbital constants (mass, radius, gravity, sol, year, obliquity, eccentricity). Verified 2026-11-05.

## jpl-mars-at-a-glance
JPL InSight press kit, "Mars at a glance" (sol length 24 h 39 m 35 s; atmosphere 95.3% CO2, 2.7% N2, 1.6% Ar by the older Viking numbers).
https://www.jpl.nasa.gov/news/press_kits/insight/launch/facts/mars-at-a-glance
Use: **F** secondary. Prefer SAM values for composition.

## sam-mahaffy-2013
Mahaffy, P. R. et al. (2013). Abundance and isotopic composition of gases in the martian atmosphere from the Curiosity rover. *Science* 341(6143), 263-266. doi:10.1126/science.1237966
Record: https://elib.dlr.de/87348
Use: **F** for CO2 0.960±0.007, 40Ar 0.0193±0.0001, N2 0.0189±0.0003, O2 1.45±0.09e-3, CO <1e-3.

## meda-2023-naturegeo
Rodriguez-Manfredi, J. A. et al. (2023). The diverse meteorology of Jezero crater over the first 250 sols of Perseverance on Mars. *Nature Geoscience*. doi:10.1038/s41561-022-01084-0
https://link.springer.com/10.1038/s41561-022-01084-0
Use: **F** for landing coordinates, thermal inertia range (180-605), albedo behaviour, temperatures at four heights, surface energy budget terms. Primary source for Jezero.

## meda-year1-upvehu-2023
University of the Basque Country / UPV-EHU press release on the first Mars year of MEDA results (Sánchez-Lavega, Hueso, del Río-Gaztelurrutia, Munguira), Jan 2023. Mean air temperature ~-55 °C, large diurnal swings, seasonal pressure cycle, Jan 2022 dust storm.
https://www.eurekalert.org/news-releases/977001 (also phys.org mirror)
Use: **F** secondary for annual mean temperature and qualitative behaviour. Agent should replace with the underlying papers (Sánchez-Lavega et al. 2023, *Nature Geoscience* cover issue) and the PDS archive.

## meda-first-report-2021
NASA/JPL first MEDA weather report, Feb 2021: surface pressure 718 Pa, clearer atmosphere than Gale at landing. Press reports:
https://www.fox35orlando.com/news/nasa-gets-first-weather-report-from-mars-rover-landing-site
Use: **F** for the 718 Pa first reading. Agent: replace with the NASA Mars 2020 mission page or PDS.

## meda-rds-epsc2026
Rodriguez-Veloso, R. et al. (2026). Aerosol optical properties and dust deposition as observed by MEDA RDS at Jezero crater. EPSC 2026, EPSC2026-378. Also EPSC2024-508 and EPSC-DPS2025-680 by the same group.
https://meetingorganizer.copernicus.org/EPSC2026/EPSC2026-378.html
Use: **F** for optical depth behaviour and dust deposition on sensors (relevant to solar panel degradation models).

## lemmon-2022-duststorm
Lemmon, M. T. et al. (2022). Dust, sand and winds within an active Martian storm in Jezero crater. *Geophysical Research Letters* 49(17). Peak tau ~2 over 5-11 Jan 2022.
Use: **F** for storm optical depth. (URL to be added by agent via DOI lookup.)

## meda-dustdevils-rds
Toledo, D. et al. Dust devil frequency of occurrence and radiative effects at Jezero crater, Mars, as measured by MEDA RDS. 374 dust devils in the first 365 sols; peak 12:00-13:00 LTST.
https://digitalpro.inta.es/handle/123456789/1092
Use: **F** for dust devil frequency.

## meda-pds-archive
PDS Atmospheres Node, Mars 2020 MEDA bundle (pressure, temperature, wind, humidity, RDS, TIRS per sol).
Use: **D**. Agent task F2: ingest MY36 pressure and temperature series to replace every value marked APPROX in `jezero.json`. (Agent to record the exact bundle URL after locating it on https://pds-atmospheres.nmsu.edu.)

## rad-hassler-2013
Hassler, D. M. et al. (2013). Mars' surface radiation environment measured with the Mars Science Laboratory's Curiosity rover. *Science* 342(6169). GCR dose equivalent 0.64±0.12 mSv/day (some outlets report 0.67 after re-averaging); absorbed dose 0.210±0.040 mGy/day; cruise 1.84±0.30 mSv/day.
Press: https://www.swri.org/node/9079 and https://phys.org/news/2013-12-scientists-publish-surface-mars.amp
Use: **F** for radiation.

## rad-dlr-2016
Reitz, G. et al. (2016). Radiation measurements of MSL-RAD on the surface of Mars. ICES 2016. Confirms 0.64±0.12 mSv/day surface, 1.84±0.3 cruise.
https://elib.dlr.de/106090
Use: **F** confirming.

## plesa-2016-heatflux
Plesa, A.-C. et al. (2016). How large are present-day heat flux variations across the surface of Mars? *JGR Planets*. doi:10.1002/2016JE005126. Average 23.2-27.3 mW/m²; InSight site 18.8-24.2.
https://openpolar.no/Record/ftinsu:oai:HAL:hal-02458627v1/Details
Use: **F** modeled heat flow (pre-InSight thermal evolution models).

## frizzell-2023-heatflow
Frizzell, K. R., Ojha, L., Karunatillake, S. (2023). Bounding the unknowns of martian crustal heat flow from a synthesis of regional geochemistry and InSight mission data. *Icarus* 405. doi:10.1016/j.icarus.2023.115700. Mean crustal heat flow 3.0-13.9 mW/m².
https://repository.lsu.edu/geo_pubs/2230
Use: **F** modeled heat flow (post-InSight). Note the InSight HP3 "mole" never reached design depth, so there is still no direct measurement.

## wright-2024-midcrust-water
Wright, V., Morzfeld, M., Manga, M. (2024). Liquid water in the Martian mid-crust. *PNAS*. doi:10.1073/pnas.2409983121. Water-saturated fractured igneous rock at 11.5-20 km best explains InSight seismic data.
https://phys.org/news/2024-08-scientists-oceans-mars-deep.pdf
Use: **F** hypothesis tier only.

## hecht-2009-perchlorate
Hecht, M. H. et al. (2009). Detection of perchlorate and the soluble chemistry of martian soil at the Phoenix lander site. *Science* 325(5936), 64-67. doi:10.1126/science.1172466
https://experts.arizona.edu/en/publications/detection-of-perchlorate-and-the-soluble-chemistry-of-martian-soi/
Use: **F** for perchlorate ~0.5 wt%.

## kounaves-2010-wcl
Kounaves, S. P. et al. (2010). Wet Chemistry experiments on the 2007 Phoenix Mars Scout Lander mission: Data analysis and results. *JGR* 115, E00E10. doi:10.1029/2009JE003424
Use: **F** for soluble ion chemistry, pH (slightly alkaline), carbonate.

## swim-psi
Subsurface Water Ice Mapping (SWIM) project, Planetary Science Institute / JPL (Putzig, Morgan et al.). SWIM 1.0 (2019, northern hemisphere), 2.0 (2020, southern + Tharsis), SWIM4IMIM (ongoing, CTX/HiRISE).
https://swim.psi.edu/
Use: **D** and **F**. Ice consistency maps (<5 m and >5 m zones). Agent: download the SWIM 2.0 product rasters for any second region.

## mola-megdr
Smith, D. E., Neumann, G. A. et al. MGS MOLA Mission Experiment Gridded Data Record (MEGDR), MGS-M-MOLA-5-MEGDR-L3-V1.0, NASA PDS Geosciences Node, 2003. 4 to 128 pixels/degree topography relative to the areoid.
https://pds-geosciences.wustl.edu/missions/mgs/megdr.html (PDS4 migration: https://pds.nasa.gov/data/pds4/releases/geo/mgs_mola_topography_derived-20260825/readme.txt)
Use: **D**. Agent task T1: ingest MEG128 tile covering Jezero. Note the MAP_SCALE precision issue documented at the Geosciences Node when overlaying with HiRISE.

## stack-2020-jezero-map
Stack, K. M. et al. (2020). Photogeologic map of the Perseverance rover field site in Jezero crater constructed by the Mars 2020 science team. *Space Science Reviews* 216:127. doi:10.1007/s11214-020-00739-x. Mapped at 1:5000 on a 25 cm/px HiRISE orthomosaic and 1 m/px HiRISE stereo DTM. Now open access (CC-BY 4.0 since July 2025).
https://authors.library.caltech.edu/records/a7qs5-xhq84
Use: **D** (the supplementary DTM/ortho) and **F** for geologic units. Agent task T1: the 1 m DTM is the terrain for the playable region.

## mcd-lmd
Millour, E., Forget, F. et al. The Mars Climate Database, version 6.1 (2022-2024). LMD/IPSL, Open University, Oxford, IAA; ESA/CNES supported. Global circulation model outputs: pressure, temperature, winds, dust, water vapour and ice columns, radiative fluxes, several dust scenarios (climatology, cold, warm, storm). Free on request; web interface for quick looks.
https://www-mars.lmd.jussieu.fr/
Use: **D** and **F** modeled. This is the right source for anything the rovers did not measure (winds aloft, water vapour, other seasons, other sites). Agent task F3: get MCD access and generate the diurnal/seasonal climatology for Jezero; store as modeled-tier series with MCD version recorded.

## moxie-hoffman-2022
Hoffman, J. A. et al. (2022). Mars Oxygen ISRU Experiment (MOXIE): Preparing for human Mars exploration. *Science Advances* 8(35). doi:10.1126/sciadv.abp8636. Seven 2021 runs, ~50 g total, 6-8 g/h; first run 5.4 g at 751 Pa / 201 K.
https://www.science.org/doi/10.1126/sciadv.abp8636 (table mirror: https://pmc.ncbi.nlm.nih.gov/articles/PMC9432831/)
Use: **F** engineering.

## moxie-nasa-final-2023
NASA, Sept 2023: MOXIE completes 16th and final run; 122 g total; peak 12 g/h at >=98% purity, twice the original goal; full-scale concept 2-3 kg/h.
https://learningenglish.voanews.com/a/nasa-oxygen-producing-device-on-mars-performed-above-expectations/7268878.html (mirror of NASA release; agent to replace with nasa.gov URL)
Use: **F** engineering.

## moxie-mit-2021
MIT News, 21 Apr 2021: MOXIE first oxygen, 5.4 g in one hour; power supply limits to 12 g/h.
https://news.mit.edu/2021/aboard-nasa-perseverance-mars-rover-moxie-creates-oxygen-0421
Use: **F** engineering, secondary.

## wamelink-2019-crops
Wamelink, G. W. W. et al. (2019). Crop growth and viability of seeds on Mars and Moon soil simulants. *Open Agriculture* 4(1). doi:10.1515/opag-2019-0051. Ten crops in NASA JSC-1A Mars simulant vs Moon simulant vs Earth potting soil; Mars simulant comparable to Earth control; spinach failed; radish, rye, cress seeds viable.
https://doi.org/10.1515/opag-2019-0051
Use: **F** engineering, with the perchlorate and Earth-conditions caveats in `resources.json`.

## prsa-2016-iau-b3
Prša, A., Harmanec, P., Torres, G., Mamajek, E. et al. (2016). Nominal values for selected solar and planetary quantities: IAU 2015 Resolution B3. *Astronomical Journal* 152(2), 41. doi:10.3847/0004-6256/152/2/41. The paper reproduces the resolution: nominal solar constant S_N = 1361 W/m^2 (exact), nominal solar luminosity 3.828e26 W; the measured solar-cycle-23 mean it was rounded from is given as 1361 +/- 0.5 W/m^2. It also quotes IAU 2012 Resolution B2: the astronomical unit is 149 597 870 700 m exactly.
https://iopscience.iop.org/article/10.3847/0004-6256/152/2/41 (preprint: https://arxiv.org/abs/1605.09788)
Use: **F** for the solar constant and the astronomical unit. Verified 2026-11-06 (arXiv HTML and IOP page read verbatim). The IAU resolution PDFs on iau.org and the Kopp & Lean (2011) GRL paper it cites returned 404/403 at that time and are deliberately not listed as sources.

## nist-webbook-srd69
NIST Chemistry WebBook, SRD 69 (NIST Standard Reference Database 69), species pages: carbon dioxide (molecular weight 44.0095), nitrogen (28.0134), oxygen (31.9988). The pages give relative molecular mass without a stated uncertainty.
https://webbook.nist.gov/cgi/cbook.cgi?ID=C124389 (CO2), https://webbook.nist.gov/cgi/cbook.cgi?ID=C7727379 (N2), https://webbook.nist.gov/cgi/cbook.cgi?ID=C7782447 (O2)
Use: **F** for molar masses. Verified 2026-11-07.

## nist-atomic-weights
NIST Atomic Weights and Isotopic Compositions, argon page: 40Ar relative atomic mass 39.9623831237(24), isotopic composition 0.996035(25), standard atomic weight 39.948(1). The page itself carries no edition or author line; NIST's column-description page is the reference it links.
https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=Ar
Use: **F** for the 40Ar molar mass (SAM reports 40Ar specifically, so the isotope mass is used, not the terrestrial standard atomic weight). Verified 2026-11-07.

---

# Design and architecture references (R)

These are not fact sources. They are what the design agent should have read so it
can propose base, greenhouse, power and ISRU designs that resemble what serious
people have proposed, and so it knows the critiques.

## nasa-dra5
Drake, B. G. (ed.) (2009). Human Exploration of Mars Design Reference Architecture 5.0. NASA/SP-2009-566, plus Addendum NASA/SP-2009-566-ADD (July 2009). Six crew, three consecutive opportunities, ~500-day surface stays, pre-deployed cargo, ISRU for ascent propellant, nuclear surface power baseline, detailed mass and power budgets.
Main: https://www.nasa.gov/pdf/373665main_NASA-SP-2009-566.pdf
Addendum: https://www.nasa.gov/pdf/373667main_NASA-SP-2009-566-ADD.pdf
Summary paper: https://ntrs.nasa.gov/api/citations/20100028285/downloads/20100028285.pdf
Why it matters: the most complete public engineering baseline. Its surface habitat, power (fission vs solar trade), EVA and ISRU numbers are the yardstick for anything the agent generates. There is also a DRA 5.0 Addendum #2 (2014) the agent should locate.

## zubrin-mars-direct
Zubrin, R. M. & Baker, D. A. (1990/1991). Mars Direct: A proposal for the rapid exploration and colonization of the Red Planet. Also Zubrin & Wagner, *The Case for Mars* (1996; rev. 2011), Free Press, ISBN 978-0684827575.
https://en.wikipedia.org/wiki/Mars_Direct (overview); book: https://www.publishersweekly.com/9780684827575
Why it matters: the "live off the land" architecture; in-situ methane/oxygen propellant from Sabatier reaction with imported hydrogen; greenhouse and brick construction scenarios. Chapter 5 of the book is the optimistic case on radiation and gravity, which `weinersmith-city-on-mars` answers.

## spacex-musk-2017-2018
Musk, E. (2017). Making Humans a Multi-Planetary Species. *New Space* 5(2). doi:10.1089/space.2017.29009.emu. And Musk, E. (2018). Making Life Multi-Planetary. *New Space* 6(1). doi:10.1089/space.2018.29013.emu.
http://online.liebertpub.com/doi/full/10.1089/space.2017.29009.emu
Why it matters: transport architecture (reusable methalox vehicle, orbital refuelling, propellant made on Mars), cost-per-ton targets, 1-million-person city aspiration. Contains almost no surface-engineering detail; treat as a transport and economics reference only.

## weinersmith-city-on-mars
Weinersmith, K. & Weinersmith, Z. (2023). *A City on Mars: Can We Settle Space, Should We Settle Space, and Have We Really Thought This Through?* Penguin Press, ISBN 9781984881724. Hugo Award 2024; Royal Society Trivedi Science Book Prize 2024.
https://mitpressbookstore.mit.edu/book/9781984881724
Why it matters: the strongest published skeptical review. Catalogues the open questions (reproduction and child development in 0.38 g, closed-ecosystem reliability, radiation over decades, perchlorate, law and governance, company-town dynamics). The agent should use it as the checklist of things a "civilization" scenario cannot assume away without labelling the assumption.

## insight-hp3-2018
Spohn, T. et al. (2018). The Heat Flow and Physical Properties Package (HP3) for the InSight mission. *Space Science Reviews* 214:96.
https://link.springer.com/content/pdf/10.1007/s11214-018-0531-4.pdf
Why it matters: explains what a heat-flow measurement needed and why pre-mission estimates were 20-30 mW/m². The probe did not reach depth, which is why heat flow is still modeled, not measured.

## pds-general
NASA Planetary Data System: https://pds.nasa.gov/ (Geosciences node for MOLA/HiRISE DTMs; Atmospheres node for MEDA, REMS; Imaging node for HiRISE/CTX).
Why it matters: every `D` source above lives here. The agent should prefer PDS4 bundles with their label metadata over mirrored copies.
