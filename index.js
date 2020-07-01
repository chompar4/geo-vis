const tgeo = new ThreeGeo({
    tokenMapbox: 'pk.eyJ1IjoidGhvbXBzb25maWxtIiwiYSI6ImNrYzFhdXV6NTByZ2EydG9lODc4Y2V3b2QifQ.qwJLT2-CkC52qmsWxQ3e1g',                  // <---- set your Mapbox API token here
});

// params: [lat, lng], terrain's radius (km), satellite zoom resolution, callbacks
// Beware the value of radius; for zoom 12, radius > 5.0 (km) could trigger huge number of tile API calls!!
tgeo.getTerrain([46.5763, 7.9904], 5.0, 12, {
    onRgbDem: meshes => {                     // your implementation when the terrain's geometry is obtained
        meshes.forEach(mesh => scene.add(mesh));
        render();                             // now render scene after dem meshes are added
    },
    onSatelliteMat: mesh => {                 // your implementation when terrain's satellite texture is obtained
        render();                             // now render scene after dem material (satellite texture) is applied
    },
});