# Open questions and competing hypotheses

Written for humans. Each entry says what we know, what we don't, which fact ids it
touches, and how the simulation should treat it. The simulation should never pick a
side silently; it should expose the choice as a scenario setting with a visible tier.

## 1. How much heat comes out of the ground?
Known: no direct measurement. Pre-InSight models: 23-27 mW/m² global mean. Post-InSight geochemical synthesis: 3-14 mW/m². Earth: ~90.
Touches: `mars.interior.heat_flow_mean_*`.
Treatment: offer both model families as scenario choices; default to the midpoint with a wide band. Either way geothermal energy is not a power source. The useful fact for players is subsurface *thermal stability*, which does not depend on heat flow.

## 2. Is there liquid water deep in the crust, and does it matter?
Known: InSight seismic inversion (Wright 2024) favours water-saturated fractured rock at 11.5-20 km under the lander; authors argue it is likely global. Top ~5 km dry.
Touches: `jezero.subsurface.deep_liquid_water`.
Treatment: hypothesis tier. No plausible near-term drilling reaches it. Relevant to astrobiology and far-future scenarios only. A module that uses it as a water source must be labelled hypothesis-grade.

## 3. Where is accessible water ice, and is Jezero a bad site for a base?
Known: SWIM maps consistent shallow ice mostly poleward of ~35-40°; Jezero (18° N) has low likelihood. Jezero was chosen for science, not resources.
Touches: `jezero.subsurface.shallow_ice_likelihood`, `water.shallow_ice.midlatitude_depth`.
Treatment: a Jezero base must import water, mine hydrated minerals, or extract vapour at high energy cost. This is the kind of constraint a player should hit and then ask "should we build somewhere else?". The product roadmap's "more regions" should include a mid-latitude ice site so the comparison is playable.

## 4. Can regolith grow food?
Known: JSC-1A simulant grows crops in an Earth greenhouse (Wamelink 2019). Real regolith contains ~0.5 wt% perchlorate (Phoenix), likely global, toxic to humans and inhibiting to plants. Simulant lacks perchlorate.
Touches: `agriculture.simulant_trials.wageningen_2019`, `regolith.perchlorate.*`.
Treatment: two scenario toggles: (a) perchlorate remediation solved (assumption) vs. must wash/bioremediate (engineering cost), (b) regolith substrate vs. hydroponics (imported nutrients, mass budget). Crop yield under Mars light is a modeled quantity the primitives library must compute from irradiance, not a fact.

## 5. How bad is the radiation, really?
Known: 0.64±0.12 mSv/day GCR at Gale near solar max; roughly double at solar min; solar particle events add episodic doses. Career limits ~1 Sv (ESA) or risk-based (NASA). A 500-day surface stay plus transit ≈ 1 Sv.
Touches: `mars.radiation.*`, `jezero.radiation.*`.
Treatment: dose accumulates per crew member in the sim; shielding is a design parameter (regolith thickness, water walls, buried habitats). Long-term settlement health effects beyond cancer risk (CNS, cardiovascular) are not established; label any model of them as hypothesis.

## 6. Is 0.38 g survivable long term? Can people reproduce there?
Known: nothing. There is no data on mammalian development in partial gravity. Weinersmith & Weinersmith treat this as the single biggest unknown for a self-sustaining settlement.
Touches: none yet (no fact to store; that is the point).
Treatment: the sim should refuse to model multi-generational populations as fact. If a scenario needs it, it is an explicit assumption with a big label.

## 7. Can a closed ecosystem run for years?
Known: ISS life support is not closed (resupply). Biosphere 2 failed to maintain O2. MELiSSA (ESA) and Chinese Lunar Palace experiments have partial closure for months.
Touches: future `lifesupport.*` facts the agent should add with sources.
Treatment: closure fraction is a modeled parameter with a demonstrated upper bound; the engine's conservation audit (mass of O2, CO2, H2O, biomass) is what makes this honest.

## 8. Dust: storms, deposition and power
Known: regional storm at Jezero reached tau ~2 (Jan 2022). Global storms (2018) reach tau ~8-10 for months and ended Opportunity. Dust deposits on surfaces continuously; dust devils sometimes clean them.
Touches: `jezero.dust.*`.
Treatment: a stochastic storm model (regional yearly-ish, global every ~3 Mars years) with tau time series; panel soiling rate as modeled parameter from MEDA RDS deposition studies. A solar-only base must survive a global storm; that is the classic Mars engineering exam question (DRA 5.0 baselines fission for this reason).

## 9. What are the real numbers at Jezero at night in winter?
Known: MEDA measured it; the headline numbers in `jezero.json` are approximate from press summaries.
Touches: everything marked APPROX.
Treatment: agent task F2 replaces them from PDS. Until then the sim should display the range, not the point value.
Status: `jezero.location.elevation_landing` was replaced in task T1 (`jezero.location.elevation_landing_mola128`, sampled from the MEGDR tile). The atmospheric values remain for F2.

## 10. Governance, law, economics
Known: Outer Space Treaty (1967) forbids national appropriation; Moon Treaty (1979) largely unratified; property and jurisdiction unsettled. Weinersmith & Weinersmith cover this at length.
Treatment: out of scope for the physics engine, but a "civilization" layer would need it. Keep it as a documented gap, not a feature.
