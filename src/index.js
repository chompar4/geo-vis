const canvas = document.getElementById("canvas");
const camera = new THREE.PerspectiveCamera(75, canvas.width/canvas.height, 0.1, 1000);
camera.position.set(0, 0, 1.5);
camera.up.set(0, 0, 1); // important for OrbitControls

const renderer = new THREE.WebGLRenderer({
    // alpha: true,
    canvas: canvas,
});

const controls = new THREE.OrbitControls(camera, renderer.domElement);

// https://stackoverflow.com/questions/29884485/threejs-canvas-size-based-on-container
const resizeCanvasToDisplaySize = (force=false) => {
    let width = canvas.clientWidth;
    let height = canvas.clientHeight;

    // adjust displayBuffer size to match
    if (force || canvas.width != width || canvas.height != height) {
        // you must pass false here or three.js sadly fights the browser
        // console.log "resizing: #{canvas.width} #{canvas.height} -> #{width} #{height}"
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }
};
resizeCanvasToDisplaySize(true); // first time

// object stuff --------
const scene = new THREE.Scene();
const walls = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxBufferGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({color: 0xcccccc}));
walls.position.set(0, 0, 0);
scene.add(walls);
scene.add(new THREE.AxesHelper(1));

// render stuff --------
const stats = new Stats();
stats.showPanel(1); // 0: fps, 1: ms, 2: mb, 3+: custom
document.body.appendChild(stats.dom);
const render = () => {
    stats.update();
    resizeCanvasToDisplaySize();
    renderer.render(scene, camera);
};

// main --------
render(); // first time
controls.addEventListener('change', render);

const env = {
    zoom: 13, // satellite zoom resolution -- min: 11, defaut: 13, max: 17
    enableTilesLeaflet: true,
    tokenMapbox: 'pk.eyJ1IjoidGhvbXBzb25maWxtIiwiYSI6ImNrYzFhdXV6NTByZ2EydG9lODc4Y2V3b2QifQ.qwJLT2-CkC52qmsWxQ3e1g', // <---- set your Mapbox API token here
};

const tgeo = new ThreeGeo(env);

if (tgeo.tokenMapbox === '********') {
    alert('Please set your Mapbox API token in ThreeGeo constructor.');
} else {
    // params: [lat, lng], terrain's radius (km), zoom resolution, callbacks
    // Beware the value of radius; radius > 5.0 (km) could trigger huge number of tile API calls!!
    tgeo.getTerrain([46.5763, 7.9904], 5.0, env.zoom, {
        onRgbDem: (meshes) => { // your implementation when terrain's geometry is obtained
            meshes.forEach((mesh) => { scene.add(mesh); });
            render(); // now render scene after dem meshes are added
        },
        onSatelliteMat: (mesh) => { // your implementation when terrain's satellite texture is obtained
            render(); // now render scene after dem material (satellite texture) is applifed
        },
    });
}