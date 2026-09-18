"use strict";
/* ==========================================================================
   Hand the design to the two solvers people actually use for the next step.
   Neither is embedded — flow5 and OpenFOAM are GPL-3 desktop programs — so
   this writes their input decks instead, from the same geometry the parts
   are cut from:
     flow5Xml()     a plane definition for flow5 / XFLR5 (LLT, VLM, panels,
                    XFoil viscous polars, inertia and stability derivatives)
     openfoamCase() a snappyHexMesh + steady RANS case around the exported
                    STL, with the reference values already filled in
   ========================================================================== */
const M = v => (v / 1000).toFixed(5);                                  // mm -> m, as flow5 wants
const F3 = v => (+v).toFixed(3);
const xesc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------------- flow5 / XFLR5 plane ---------------- */
function flow5Xml(A) {
  const p = A.p, L = A.L, W = L.wing, out = [];
  const sectionsOf = (sts, rootX, rootY, rootZ, foilA, foilB, panelsY) => {
    const s = [];
    for (let i = 0; i < sts.length; i++) {
      const st = sts[i], nxt = sts[i + 1];
      const dy = nxt ? Math.abs(nxt.y - st.y) : 0, dz = nxt ? nxt.z - st.z : 0;
      const dih = nxt ? Math.atan2(dz, Math.max(1e-6, dy)) * 180 / Math.PI : 0;
      const span = Math.hypot(st.y - rootY, st.z - rootZ);
      s.push(`                <Section>
                    <y_position>${M(span)}</y_position>
                    <Chord>${M(st.c)}</Chord>
                    <xOffset>${M(st.x - rootX)}</xOffset>
                    <Dihedral>${F3(dih)}</Dihedral>
                    <Twist>${F3(st.twist || 0)}</Twist>
                    <x_number_of_panels>13</x_number_of_panels>
                    <x_panel_distribution>COSINE</x_panel_distribution>
                    <y_number_of_panels>${nxt ? panelsY : 0}</y_number_of_panels>
                    <y_panel_distribution>${nxt ? "COSINE" : "UNIFORM"}</y_panel_distribution>
                    <Left_Side_FoilName>${xesc((i ? foilB : foilA).name)}</Left_Side_FoilName>
                    <Right_Side_FoilName>${xesc((i ? foilB : foilA).name)}</Right_Side_FoilName>
                </Section>`);
    }
    return s.join("\n");
  };
  const wingBlock = (name, type, sts, foilA, foilB, opts = {}) => {
    const r = sts[0];
    return `        <wing>
            <Name>${xesc(name)}</Name>
            <Type>${type}</Type>
            <Position>${M(r.x)}, ${M(opts.y0 !== undefined ? opts.y0 : r.y)}, ${M(r.z)}</Position>
            <Tip_Strips>1</Tip_Strips>
            <Rx_angle>${F3(opts.rx || 0)}</Rx_angle>
            <Ry_angle>0.000</Ry_angle>
            <symmetric>${opts.sym === false ? "false" : "true"}</symmetric>
            <Two_Sided>${opts.both === false ? "false" : "true"}</Two_Sided>
            <Inertia><Mass>${(opts.mass || 0.001).toFixed(5)}</Mass></Inertia>
            <Sections>
${sectionsOf(sts, r.x, r.y, r.z, foilA, foilB, opts.panelsY || 12)}
            </Sections>
        </wing>`;
  };

  /* main wing: the planform breakpoints are exactly where the shape changes */
  const ys = [...new Set(W.breaks.map(v => +v.toFixed(3)))].sort((a, b) => a - b).filter(v => v <= W.half + 0.01);
  if (ys[ys.length - 1] < W.half - 0.01) ys.push(W.half);
  const wingSts = ys.map(y => W.wingAt(y));
  out.push(wingBlock("Main wing", "MAINWING", wingSts, W.fRoot, W.fTip, {y0: 0, panelsY: 14, mass: (A.items.filter(i => i.group === "structure").reduce((s, i) => s + i.mass, 0) || 200) / 1000}));

  /* tail surfaces, as flow5 names them */
  for (const s of L.surfaces) {
    const kind = s.kind === "fin" ? "FIN" : s.kind === "htail" ? "ELEVATOR" : "ELEVATOR";
    out.push(wingBlock(s.name === "vtail" ? "V-tail" : s.name === "fin" ? "Fin" : "Elevator", kind, s.st, L.fTail, L.fTail,
      {rx: s.kind === "fin" ? -90 : 0, both: s.mirrored, sym: true, panelsY: 8, mass: 0.02}));
  }
  for (const [i, s] of L.tipFins.entries()) for (const side of [1, -1])
    out.push(wingBlock(`Tip fin ${i + 1}${side > 0 ? "R" : "L"}`, "OTHERWING", s.st, L.fTail, L.fTail,
      {rx: -90, y0: side * s.st[0].y, sym: false, both: false, panelsY: 6, mass: 0.01}));

  /* the fuselage as a NURBS control net: keel, side, crown at each station */
  let body = "";
  if (L.hasFuse) {
    const F = L.fuse, frames = [];
    for (let i = 0; i <= 8; i++) {
      const x = F.L * i / 8, [hw, hh, zc] = F.profile(Math.min(x, F.L - 0.01));
      const pts = [[0, zc - hh], [hw * 0.8, zc - hh * 0.72], [hw, zc], [hw * 0.8, zc + hh * 0.72], [0, zc + hh]];
      frames.push(`                <frame>
                    <Angle>0</Angle>
                    <x_panels>1</x_panels>
                    <Position>${M(x)}, 0, 0</Position>
${pts.map(q => `                    <point>${M(x)}, ${M(q[0])}, ${M(q[1])}</point>`).join("\n")}
                </frame>`);
    }
    body = `        <body>
            <Name>Fuselage</Name>
            <Position>0, 0, 0</Position>
            <Type>NURBS</Type>
            <x_panels>19</x_panels>
            <hoop_panels>9</hoop_panels>
            <Inertia><Volume_Mass>${((A.items.find(i => /fuselage/i.test(i.name)) || {mass: 100}).mass / 1000).toFixed(4)}</Volume_Mass></Inertia>
            <NURBS>
                <u_degree>3</u_degree>
                <v_degree>3</v_degree>
                <uAxis>0</uAxis>
                <vAxis>2</vAxis>
                <uEdgeWeight>1</uEdgeWeight>
                <vEdgeWeight>1</vEdgeWeight>
${frames.join("\n")}
            </NURBS>
        </body>\n`;
  }

  /* every mass the balance knows about, so flow5 has the real inertia */
  const masses = A.items.filter(i => i.mass > 0.5).map(i =>
    `            <Point_Mass>
                <Tag>${xesc(i.name)}</Tag>
                <Mass>${(i.mass / 1000).toFixed(4)}</Mass>
                <coordinates>${M(i.x)}, 0, ${M(L.hasFuse ? L.fuse.profile(Math.max(1, Math.min(i.x, L.fuse.L - 1)))[2] : 0)}</coordinates>
            </Point_Mass>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE flow5>
<xflplane version="1.0">
    <!-- Written by Airframe Forge. Load the airfoils in flow5/airfoils/ first, then File > Import > Plane. -->
    <!-- Point masses carry the same positions the balance page uses; they are placed on the centreline. -->
    <Units>
        <length_unit_to_meter>1</length_unit_to_meter>
        <area_unit_to_m2>1</area_unit_to_m2>
        <mass_unit_to_kg>1</mass_unit_to_kg>
        <speed_unit_to_ms>1</speed_unit_to_ms>
        <inertia_unit_to_kgm2>1</inertia_unit_to_kgm2>
    </Units>
    <Plane>
        <Name>${xesc(p.designName || p.template || "Airframe Forge design")}</Name>
        <Description>Airframe Forge export: ${F3(p.span)} mm span, ${F3(A.mtow)} g all-up</Description>
        <Inertia>
${masses}
        </Inertia>
${body}${out.join("\n")}
    </Plane>
</xflplane>
`;
}

/* ---------------- OpenFOAM case ---------------- */
function openfoamCase(A, bbox) {
  const p = A.p, L = A.L, W = L.wing;
  const V = (A.perf.cruise && A.perf.cruise.V) || 15, rho = A.rho, nu = 1.5e-5;
  const Sref = W.S / 1e6, cref = W.mac / 1000, span = p.span / 1000;
  const mn = bbox.mn.map(v => v / 1000), mx = bbox.mx.map(v => v / 1000);
  const len = Math.max(0.2, mx[0] - mn[0]);
  const dom = {x0: mn[0] - 4 * len, x1: mx[0] + 8 * len, y0: -3 * span, y1: 3 * span, z0: mn[2] - 3 * len, z1: mx[2] + 3 * len};
  const cell = len / 12;
  const nx = Math.max(20, Math.round((dom.x1 - dom.x0) / cell)), ny = Math.max(16, Math.round((dom.y1 - dom.y0) / cell)), nz = Math.max(16, Math.round((dom.z1 - dom.z0) / cell));
  const cg = [(A.xcg || (mn[0] + mx[0]) * 500) / 1000, 0, 0];
  const I = Math.max(0.01, 0.16 * 0.02);                               // 2% turbulence intensity
  const k = 1.5 * (0.02 * V) ** 2, omega = Math.sqrt(k) / (0.1 * cref);
  const head = (cls, obj, loc) => `/*--------------------------------*- C++ -*----------------------------------*\\
| Airframe Forge export — OpenFOAM case (openfoam.org v11/v12 layout)        |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    format      ascii;
    class       ${cls};
    ${loc ? `location    "${loc}";\n    ` : ""}object      ${obj};
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
`;
  const field = (name, cls, dims, internal, extra) => head(cls, name, "0") + `
dimensions      ${dims};

internalField   uniform ${internal};

boundaryField
{
    inlet   { type fixedValue; value uniform ${internal}; }
    outlet  { ${name === "p" ? "type fixedValue; value uniform 0;" : "type zeroGradient;"} }
    farfield { type slip; }
    aircraft { ${extra} }
}
`;
  const files = [];
  files.push({name: "openfoam/system/controlDict", text: head("dictionary", "controlDict", "system") + `
application     foamRun;
solver          incompressibleFluid;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         1500;
deltaT          1;
writeControl    timeStep;
writeInterval   250;
purgeWrite      2;
writeFormat     binary;
writePrecision  8;
runTimeModifiable true;

functions
{
    forces
    {
        type            forceCoeffs;
        libs            ("libforces.so");
        writeControl    timeStep;
        writeInterval   10;
        patches         (aircraft);
        rho             rhoInf;
        rhoInf          ${rho.toFixed(4)};
        liftDir         (0 0 1);
        dragDir         (1 0 0);
        CofR            (${cg.map(v => v.toFixed(4)).join(" ")});
        pitchAxis       (0 1 0);
        magUInf         ${V.toFixed(3)};
        lRef            ${cref.toFixed(4)};
        Aref            ${Sref.toFixed(5)};
    }
}
`});
  files.push({name: "openfoam/system/fvSchemes", text: head("dictionary", "fvSchemes", "system") + `
ddtSchemes      { default steadyState; }
gradSchemes     { default cellLimited Gauss linear 1; }
divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div(phi,k)      bounded Gauss upwind;
    div(phi,omega)  bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes   { default corrected; }
wallDist        { method meshWave; }
`});
  files.push({name: "openfoam/system/fvSolution", text: head("dictionary", "fvSolution", "system") + `
solvers
{
    p           { solver GAMG; tolerance 1e-7; relTol 0.01; smoother GaussSeidel; }
    "(U|k|omega)" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol 0.1; }
}

SIMPLE
{
    nNonOrthogonalCorrectors 1;
    consistent      yes;
    residualControl { p 1e-4; U 1e-4; "(k|omega)" 1e-4; }
}

relaxationFactors { equations { U 0.9; ".*" 0.9; } }
`});
  files.push({name: "openfoam/system/blockMeshDict", text: head("dictionary", "blockMeshDict", "system") + `
scale   1;

vertices
(
    (${dom.x0.toFixed(3)} ${dom.y0.toFixed(3)} ${dom.z0.toFixed(3)})
    (${dom.x1.toFixed(3)} ${dom.y0.toFixed(3)} ${dom.z0.toFixed(3)})
    (${dom.x1.toFixed(3)} ${dom.y1.toFixed(3)} ${dom.z0.toFixed(3)})
    (${dom.x0.toFixed(3)} ${dom.y1.toFixed(3)} ${dom.z0.toFixed(3)})
    (${dom.x0.toFixed(3)} ${dom.y0.toFixed(3)} ${dom.z1.toFixed(3)})
    (${dom.x1.toFixed(3)} ${dom.y0.toFixed(3)} ${dom.z1.toFixed(3)})
    (${dom.x1.toFixed(3)} ${dom.y1.toFixed(3)} ${dom.z1.toFixed(3)})
    (${dom.x0.toFixed(3)} ${dom.y1.toFixed(3)} ${dom.z1.toFixed(3)})
);

blocks ( hex (0 1 2 3 4 5 6 7) (${nx} ${ny} ${nz}) simpleGrading (1 1 1) );

boundary
(
    inlet    { type patch; faces ((0 4 7 3)); }
    outlet   { type patch; faces ((1 2 6 5)); }
    farfield { type patch; faces ((0 1 5 4) (3 7 6 2) (0 3 2 1) (4 5 6 7)); }
);
`});
  files.push({name: "openfoam/system/snappyHexMeshDict", text: head("dictionary", "snappyHexMeshDict", "system") + `
castellatedMesh true;
snap            true;
addLayers       true;

geometry
{
    aircraft.stl { type triSurfaceMesh; name aircraft; }
    refineBox
    {
        type searchableBox;
        min (${(mn[0] - 0.5 * len).toFixed(3)} ${(-0.7 * span).toFixed(3)} ${(mn[2] - 0.4 * len).toFixed(3)});
        max (${(mx[0] + 2 * len).toFixed(3)} ${(0.7 * span).toFixed(3)} ${(mx[2] + 0.4 * len).toFixed(3)});
    }
}

castellatedMeshControls
{
    maxLocalCells   2000000;
    maxGlobalCells  12000000;
    minRefinementCells 10;
    nCellsBetweenLevels 3;
    resolveFeatureAngle 30;
    allowFreeStandingZoneFaces true;
    locationInMesh  (${(dom.x0 + 0.05 * len).toFixed(3)} ${(0.45 * (dom.y1 - dom.y0) + dom.y0).toFixed(3)} ${(dom.z1 - 0.1 * len).toFixed(3)});
    features        ( { file "aircraft.eMesh"; level 4; } );
    refinementSurfaces { aircraft { level (3 4); } }
    refinementRegions  { refineBox { mode inside; levels ((1e15 2)); } }
}

snapControls
{
    nSmoothPatch    3;
    tolerance       2.0;
    nSolveIter      50;
    nRelaxIter      6;
    nFeatureSnapIter 12;
    implicitFeatureSnap false;
    explicitFeatureSnap true;
    multiRegionFeatureSnap false;
}

addLayersControls
{
    relativeSizes   true;
    layers          { aircraft { nSurfaceLayers 4; } }
    expansionRatio  1.2;
    finalLayerThickness 0.4;
    minThickness    0.1;
    nGrow           0;
    featureAngle    120;
    nRelaxIter      5;
    nSmoothSurfaceNormals 1;
    nSmoothNormals  3;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedianAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter      50;
}

meshQualityControls
{
    maxNonOrtho     65;
    maxBoundarySkewness 20;
    maxInternalSkewness 4;
    maxConcave      80;
    minVol          1e-13;
    minTetQuality   1e-15;
    minArea         -1;
    minTwist        0.02;
    minDeterminant  0.001;
    minFaceWeight   0.02;
    minVolRatio     0.01;
    minTriangleTwist -1;
    nSmoothScale    4;
    errorReduction  0.75;
}

mergeTolerance 1e-6;
`});
  files.push({name: "openfoam/system/surfaceFeaturesDict", text: head("dictionary", "surfaceFeaturesDict", "system") + `
surfaces        ("aircraft.stl");
includedAngle   150;
`});
  files.push({name: "openfoam/system/decomposeParDict", text: head("dictionary", "decomposeParDict", "system") + `
numberOfSubdomains 8;
method          scotch;
`});
  files.push({name: "openfoam/constant/physicalProperties", text: head("dictionary", "physicalProperties", "constant") + `
viscosityModel  constant;
nu              ${nu};
`});
  files.push({name: "openfoam/constant/momentumTransport", text: head("dictionary", "momentumTransport", "constant") + `
simulationType  RAS;

RAS
{
    model           kOmegaSST;
    turbulence      on;
    printCoeffs     on;
}
`});
  files.push({name: "openfoam/0/U", text: field("U", "volVectorField", "[0 1 -1 0 0 0 0]", `(${V.toFixed(3)} 0 0)`, "type noSlip;")});
  files.push({name: "openfoam/0/p", text: field("p", "volScalarField", "[0 2 -2 0 0 0 0]", "0", "type zeroGradient;")});
  files.push({name: "openfoam/0/k", text: field("k", "volScalarField", "[0 2 -2 0 0 0 0]", k.toExponential(4), "type kqRWallFunction; value uniform " + k.toExponential(4) + ";")});
  files.push({name: "openfoam/0/omega", text: field("omega", "volScalarField", "[0 0 -1 0 0 0 0]", omega.toExponential(4), "type omegaWallFunction; value uniform " + omega.toExponential(4) + ";")});
  files.push({name: "openfoam/0/nut", text: field("nut", "volScalarField", "[0 2 -1 0 0 0 0]", "0", "type nutUSpaldingWallFunction; value uniform 0;")});
  files.push({name: "openfoam/Allrun", text: `#!/bin/sh
cd "\${0%/*}" || exit 1
. "\${WM_PROJECT_DIR:?}/bin/tools/RunFunctions"

runApplication blockMesh
runApplication surfaceFeatures
runApplication snappyHexMesh -overwrite
runApplication checkMesh -allGeometry -allTopology
runApplication foamRun -solver incompressibleFluid

# lift, drag and pitching moment land in postProcessing/forces/0/coefficient.dat
`});
  files.push({name: "openfoam/README.txt", text: `OpenFOAM case — written by Airframe Forge
=========================================

Aircraft        ${p.designName || p.template || "design"}, ${F3(p.span)} mm span, ${F3(A.mtow)} g
Reference area  ${Sref.toFixed(5)} m2 (the wing area the tool uses)
Reference chord ${cref.toFixed(4)} m (mean aerodynamic chord)
Freestream      ${V.toFixed(2)} m/s at ${F3(p.altitude)} m, rho ${rho.toFixed(4)} kg/m3, nu ${nu} m2/s
Re (MAC)        ${((V * cref) / nu).toExponential(3)}
Moment centre   the CG the balance page reports, ${(cg[0] * 1000).toFixed(0)} mm from the nose

Run it
------
  cp ../cfd/aircraft_flight_position_m.stl constant/triSurface/aircraft.stl   (already placed)
  ./Allrun

Written for the openfoam.org line (v11/v12): the solver is
"foamRun -solver incompressibleFluid", turbulence lives in
constant/momentumTransport and viscosity in constant/physicalProperties.
On the ESI line (openfoam.com, v2312+) run simpleFoam instead and rename
those two files to turbulenceProperties and transportProperties.

What to compare
---------------
postProcessing/forces/0/coefficient.dat gives Cl, Cd and Cm against the same
reference area, chord and speed the tool's own analysis uses, so the numbers
sit directly beside the Aerodynamics page. Expect the panel method to be
optimistic on drag: it carries no separation and only an estimate of the
trip and wake, which is exactly what this case is for.

The mesh is a starting point, not a converged study: check y+ from
checkMesh and the forces history before believing any of it, and refine
refinementSurfaces / addLayers until the coefficients stop moving.
`});
  return files;
}
