# Airframe Forge

A browser-based designer for 3D-printable fixed-wing and VTOL UAVs. Pick a configuration, shape the airframe, choose airfoils and a power plant, check the aerodynamics and balance, then export watertight STL parts ready for the slicer.

Everything runs client-side in plain JavaScript with [three.js](https://threejs.org) for the 3D view. No build step.

## Run it

```bash
cd airframe-forge
python -m http.server 8765
# open http://127.0.0.1:8765/
```

Opening `index.html` directly from disk also works.

## What it does

**Configurations.** Tapered or swept wings (including forward sweep) and deltas, single panel or cranked with a kink station that has its own sweep, taper and dihedral, plus canted winglets and an optional smooth wing-to-fuselage blend (chord and thickness grow into the fuselage side). The fuselage cross-section and side profile are editable: height split above and below the center line, flat top and flat bottom, widest station, nose fullness and tip size, tail-cone fullness and rise. Conventional, T-tail, V-tail, twin-boom and tailless layouts. Nose tractor, pusher and twin wing-mounted motors. Ten starting templates: FPV cruiser, twin-boom pusher, twin-motor, swept flying wing, forward-swept twin, plank, delta, blended long-range cruiser, quadplane and tailsitter.

**Airfoils.** NACA 4- and 5-digit generators (including reflexed 5-digit sections for flying wings) and Selig/Lednicer `.dat` import from the UIUC database. Root, tip, body and tail sections blend along the span.

**Aerodynamics.** A vortex-lattice solver for all lifting surfaces gives CLα, the neutral point, span efficiency, span loading, stall onset and trim (stabilizer incidence, or hands-off trim speed and elevon deflection for tailless designs). Charts cover the lift curve, drag polar, L/D and pitching moment. A linear-vortex panel method gives section pressure distributions, and a slender-body source model adds fuselage surface pressure. The 3D view can color the aircraft by pressure or stall margin. These are potential-flow estimates; the export includes an assembly STL and an AVL model for viscous CFD or AVL.

**Power lab.** Battery (with voltage sag) → ESC → brushless motor (Kv, Rm, Io) → propeller model. Thrust and drag versus speed, throttle and current at cruise, top speed, climb and hover. The lab ranks every motor class, propeller and cell count for the current airframe at equal battery energy and can save setups for side-by-side comparison.

**Weight, range and balance.** Component-level mass and CG model, maximum takeoff weight showing which limit binds (stall, thrust or spar strength), payload–range, automatic battery placement and flight-test calibration of mass, drag and power.

**Mission optimizer.** Differential evolution over span, aspect ratio, taper, airfoils, battery and optionally motor and propeller, subject to payload, range or endurance, stall, cruise speed, span and mass limits.

**Printable parts.**
- Wings and tails split at automatic or user-placed cuts, with spar bores sized to the chosen carbon tube or rod, and blind joiner-pin pockets at every cut. Cranked wings always split at the kink and carry one straight spar run per panel
- Separate ailerons, elevons, elevators and rudders with a rounded pinned hinge, pin pockets in the wing and printed control horns
- Servo pockets with glue-in servo frames and screw-on covers (M3 heat-set inserts); DS041MG-class, 9 g micro, slim or custom servos. Servo position, pocket offset and horn position, side and arm length are adjustable, and servos and horns can be dragged in the 3D view
- Hollow fuselage shells with joiner sleeves, a replaceable FPV nose with camera cradle (spigot or 4 × M3 insert ring), battery and avionics hatches cut from the shell (front tongue plus magnet or screw latch), a swappable streamlined FPV canopy (blank, camera or GPS) over an avionics bay with a glue-in FC shelf, and an underslung pod on insert bosses
- NACA-style intake duct inserts and exhaust ports that can be dragged anywhere on the fuselage, with a cooling-flow estimate
- Glue-in battery tray with strap slots
- Motor mounts with 9×9 to 30×30 square, 16/19 and 19/25 cross, combined or universal slotted hole patterns
- Bolt-on quadplane VTOL kit: wing hardpoint blocks, boom saddles, boom clamps and lift motor mounts
- Gluing jigs that hold wing panels at the right incidence, washout and dihedral

Every exported part is a closed, watertight solid. The build sheet lists print settings per part, the hardware to buy (spars, pins, inserts, screws, magnets, straps, servos), the balance point and the checks.

## Limits

The numbers are conceptual-design estimates: potential-flow aerodynamics with empirical section drag and stall, and generic motor-class data. Replace the motor values with your datasheet, calibrate against a flight test, and verify critical designs in XFLR5, AVL or a viscous CFD code before flying.

## Code map

| File | Purpose |
|---|---|
| `js/data.js` | Materials, batteries, motors, props, servos, mount patterns, parameter schema, templates |
| `js/foils.js` | Airfoil generation and import, section properties, panel method |
| `js/layout.js` | Parameters → wing sections, tails, fuselage, booms, motors |
| `js/aero.js` | Vortex lattice, induced drag, strip stall and profile drag |
| `js/power.js` | Battery, motor and propeller models |
| `js/analysis.js` | Masses, CG, stability, trim, performance, MTOW, checks |
| `js/geometry-core.js` | Loft and plate kernel, STL, ZIP and AVL writers |
| `js/geometry.js` | Printable part assembly |
| `js/flowfield.js` | Fuselage surface pressure and cooling estimate |
| `js/search.js` | Power-plant ranking and mission optimizer |
| `js/charts.js`, `js/viewer.js`, `js/ui-*.js` | Charts, 3D view and interface |

`app.html` is the page fragment used for the hosted version; `index.html` wraps it for local use.
