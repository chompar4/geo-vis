const { THREE, Threelet, Stats, DatGuiDefaults, jQuery: $ } = window;

const env = {
    zoom: 15, // satellite zoom resolution -- min: 11, defaut: 13, max: 17
    tokenMapbox: 'pk.eyJ1IjoidGhvbXBzb25maWxtIiwiYSI6ImNrYzFhdXV6NTByZ2EydG9lODc4Y2V3b2QifQ.qwJLT2-CkC52qmsWxQ3e1g', // <---- set your Mapbox API token here
};

const createTextSprite = (text, color) => Threelet.Utils.createCanvasSprite(
    Threelet.Utils.createCanvasFromText(text, 150, 40, {
        tfg: color,
        fontSize: '18px',
        fontFamily: 'Times',
    }));

const createPoint = (lat, lng, elevation, viewer) => {

    // add a point
    const { proj, unitsPerMeter } = viewer.tgeo.getProjection(viewer._origin, viewer._radius);
    const dot = new THREE.Points(
        new THREE.Geometry(),
        new THREE.PointsMaterial({
            size: 8,
            sizeAttenuation: false,
            color: 0x00cccc,
        }));

    const [x, y] = proj([lat, lng]), z = elevation;

    dot.geometry.vertices.push(new THREE.Vector3(
        x, y, z * unitsPerMeter));
    viewer.scene.add(dot);
}
    

class Viewer {
    constructor(env, threelet) {
        this.env = env;

        const { camera, renderer } = threelet;
        this.threelet = threelet;
        this.camera = camera;
        this.renderer = renderer;

        this.guiHelper = null;

        this.scene = new THREE.Scene();

        //======== add light
        if (0) {
            // https://github.com/mrdoob/three.js/blob/master/examples/webvr_cubes.html
            this.scene.add(new THREE.HemisphereLight(0x606060, 0x404040));
            const light = new THREE.DirectionalLight(0xffffff);
            light.position.set(0, 0, 1).normalize();
            this.scene.add(light);
        }

        //======== add sub-camera
        if (0) {
            const cam = new THREE.PerspectiveCamera(60, 1, 0.01, 0.5);
            this.scene.add(new THREE.CameraHelper(cam));
            cam.position.set(0, 0, 2);
            cam.rotation.x = Math.PI / 4;
            cam.updateMatrixWorld();  // reflect pose change to CameraHelper
        }

        //======== add walls and axes
        const walls = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxBufferGeometry(1, 1, 1)),
            new THREE.LineBasicMaterial({color: 0xcccccc}));
        walls.position.set(0, 0, 0);
        walls.name = "singleton-walls";
        this.scene.add(walls);

        const axes = new THREE.AxesHelper(1);
        axes.name = "singleton-axes";
        this.scene.add(axes);

        // ======== adding geo tiles
        this.renderer.autoClear = false;

        this.wireframeMat = new THREE.MeshBasicMaterial({
            wireframe: true,
            color: 0x999999,
        });
        this.satelliteMats = {};
        this.objsInteractive = [];
        this._isRgbDemLoaded = false;
        this._isVectorDemLoaded = false;
        this.unitsSide = 1.0;

        this.tgeo = new ThreeGeo({
            unitsSide: this.unitsSide,
            tokenMapbox: this.env.tokenMapbox,
        });

        // vector dem: 9--15 (at 8, no contour data returned)
        // rbg dem: ?--15 per https://www.mapbox.com/help/access-elevation-data/#mapbox-terrain-rgb
        // satellite zoom resolution -- min: 11, defaut: 13, max: 17
        this._zoom = this.env.zoom || 13;
        this._radius = 5.0*2**(13-this._zoom);
        let query = Viewer.parseQuery();
        this._origin = query.origin;
        this._vis = query.mode;

        this._debugLoading = this.env.debugLoading === true;
        this._debugTitleLast = 'invalid';
        if (this._debugLoading) { // use cache for debug....
            this._setApiDebug(this.tgeo, query.title);
        }

        this.updateTerrain(this._vis);

        this._projection = this.tgeo.getProjection(this._origin, this._radius);

        // ------- msg stuff
        this.$msg = $('#msg');
        this.$msgTerrain = $('#msgTerrain');

        // ------- orbit stuff -------
        this._orbit = null;
        this._isOrbiting = false;

    } // end constructor()

    static parseQuery() {
        let _parsedQ = location.search;
        console.log('_parsedQ:', _parsedQ);

        let _origin, _title;
        if (_parsedQ.lat && _parsedQ.lng) {
            _origin = [Number(_parsedQ.lat), Number(_parsedQ.lng)];
            _title = _parsedQ.title;
        } else {
            console.log('enforcing the default location...');
            _origin =  [-37.30258, 148.91575];
            _title = "Errinundra Plateau";
        }

        let _mode = _parsedQ.mode;
        _mode = _mode ? this.capitalizeFirst(_mode.toLowerCase()) : "Satellite";

        return {
            origin: _origin,
            title: _title,
            mode: _mode,
        };
    }
    static capitalizeFirst(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    // loading stuff --------
    static _disposeMaterial(mat) {
        if (mat.map) mat.map.dispose();
        mat.dispose();
    }
    static _disposeObject(obj) { // cf. https://gist.github.com/j-devel/6d0323264b6a1e47e2ee38bc8647c726
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) this._disposeMaterial(obj.material);
        if (obj.texture) obj.texture.dispose();
    }
    clearTerrainObjects() {
        this.renderer.dispose(); // cf. https://gist.github.com/j-devel/6d0323264b6a1e47e2ee38bc8647c726

        // this.
        //    this.wireframeMat                        intact
        //    this.objsInteractive               vv    to be cleared
        //    this._isRgbDemLoaded               vv    to be set false
        //    this._isVectorDemLoaded            vv    to be set false
        //    ::::this.satelliteMats             vv    to be cleared
        //        dem-rgb-12/2257/2458        vv    to be cleared
        //        dem-rgb-12/2257/2459        vv    to be cleared
        //        ...                         vv
        //========
        this.objsInteractive.length = 0;
        //--
        this._isRgbDemLoaded = false;
        this._isVectorDemLoaded = false;
        //--
        Object.entries(this.satelliteMats).forEach(([k, mat]) => {
            delete this.satelliteMats[k];
            Viewer._disposeMaterial(mat);
        });

        // this.scene.children
        //::::Mesh walls                      intact
        //::::Mesh dem-rgb-...             vv   to be cleared
        //::::Line dem-vec-line-...        vv   to be cleared
        //::::Mesh dem-vec-shade-...       vv   to be cleared
        //::::LineLoop ""  orbit           vv   this._removeOrbit()
        //========
        this.scene.children.filter(
            obj => obj.name.startsWith('dem-'))
                .forEach(dem => {
                    dem.parent.remove(dem);
                    Viewer._disposeObject(dem);
                });
        //--
        this._removeOrbit();
        if (this.guiHelper) {
            this.guiHelper.autoOrbitController.setValue(false);
        }
        //--
    }
    reloadPageWithLocation(ll, title=undefined) {
        let href = `./index.html?lat=${ll[0]}&lng=${ll[1]}`;
        if (title) {
            href += `&title=${title}`;
        }

        if (0) {
            window.location.href = href; // deprecated
        } else {
            // https://stackoverflow.com/questions/35395485/change-url-without-refresh-the-page/35395594
            // window.history.pushState(null, '', href);
            window.history.replaceState(null, '', href);

            this.clearTerrainObjects();
            this._render();
            if (1) {
                console.log('======== ========');
                console.log('this:', this);
                console.log('this.scene.children:', this.scene.children);
                console.log('======== ========');
            }

            // update terrain
            this._origin = ll;
            this.showMsgTerrain();
            if (this._debugLoading) {
                this._setApiDebug(this.tgeo, title);
            }
            this.updateTerrain(this._vis);
        }
    }
    updateTerrain(vis) {
        switch (vis.toLowerCase()) {
            case "satellite":
                console.log('update to satellite');
                this.loadRgbDem(() => {
                    this._render();
                });
                break;
            case "wireframe":
                console.log('update to wireframe');
                this.loadRgbDem(() => {
                    // override the default satellite texture
                    this.updateMode("Wireframe");
                    this._render();
                });
                break;
            case "contours":
                console.log('update to contours');
                this.loadVectorDem(() => {
                    this._render();
                });
                break;
            default:
                break;
        }
    }
    _setApiDebug(tgeo, title) {
        console.log('_setApiDebug(): title:', title);
        if (title) {
            this._debugTitleLast = title; // update the last
        } else {
            title = this._debugTitleLast; // use the last
        }
        let _location = 'invalid';
        if (title.includes('Table')) _location = 'table';
        if (title.includes('Eiger')) _location = 'eiger';
        if (title.includes('River')) _location = 'river';
        if (title.includes('Akagi')) _location = 'akagi';
        tgeo.setApiVector(`../cache/${_location}/custom-terrain-vector`);
        tgeo.setApiRgb(`../cache/${_location}/custom-terrain-rgb`);
        tgeo.setApiSatellite(`../cache/${_location}/custom-satellite`);
    }

    nop() { /* nop */ }
    loadRgbDem(cb=this.nop) {
        if (this._isRgbDemLoaded) { return cb(); }
        if (this.env.tokenMapbox === '********') {
            const msg = 'Please set a valid Mapbox token in env.js';
            console.log(msg);
            alert(msg);
            return cb();
        }

        this._isRgbDemLoaded = true;
        this.tgeo.getTerrain(this._origin, this._radius, this._zoom, {
            onRgbDem: (meshes) => {
                meshes.forEach((mesh) => {
                    console.log('rgb DEM mesh:', mesh);
                    this.scene.add(mesh);
                    console.log('userData:', mesh.userData);

                    //======== how to visualize constituent tiles of the terrain
                    const tile = mesh.userData.threeGeo.tile;
                    const { proj } = this.tgeo.getProjection(this._origin, this._radius);
                    const { obj, offset } = ThreeGeo.Utils.bboxToWireframe(
                    ThreeGeo.Utils.tileToBbox(tile), proj, {offsetZ: - 0.05});
        
                    const sp = createTextSprite(`${tile.join('-')}`, '#000000');
                    sp.position.set(offset[0], offset[1], offset[2] + 0.05);
                    this.scene.add(obj, sp);
                });

                createPoint(-37.30051, 148.91593, 1000, this)

                this._render();
            },
            onSatelliteMat: (plane) => {
                plane.material.side = THREE.DoubleSide;
                this.satelliteMats[plane.name] = plane.material;
                this._render();
                return cb();
            },
        });
    }
    loadVectorDem(cb=this.nop) {
        if (this._isVectorDemLoaded) { return cb(); }
        if (this.env.tokenMapbox === '********') {
            console.log('Please set a valid Mapbox token in env.js');
            return cb();
        }

        console.log('load vector dem: start');
        this._isVectorDemLoaded = true;
        this.tgeo.getTerrain(this._origin, this._radius, this._zoom, {
            onVectorDem: (objs) => {
                console.log('load vector dem: end');
                // dem-vec-shade-<ele>-* and dem-vec-line-<ele>-*
                objs.forEach((obj) => {
                    this.scene.add(obj);
                });
                this._render();
                return cb();
            },
        });
    }

    static _calcOrbit(cam, pt) {
        let campos = cam.position.clone();

        // shrink the cone by 5 meters so the orbit is visible to the cam
        // let shift = pt.clone().sub(campos).normalize().multiplyScalar(0.005);
        //----
        let shift = new THREE.Vector3(0, 0, 0);

        let camposShifted = campos.add(shift);

        let center = pt.clone().setZ(camposShifted.z);
        let rvec = new THREE.Vector2(
            camposShifted.x - pt.x,
            camposShifted.y - pt.y);
        return {
            center: center,
            rvec: rvec,
            target: pt.clone(),
        };
    }
    _addOrbit(orbit, segments=128) {
        let radius = orbit.rvec.length();
        let geom = new THREE.CircleGeometry(radius, segments);
        geom.vertices.shift(); // remove the center vertex
        this._orbit = new THREE.LineLoop(geom,
            new THREE.LineBasicMaterial({color: 0xff00ff}));
        this._orbit.position.set(orbit.center.x, orbit.center.y, orbit.center.z);
        this._orbit.userData.radius = radius;
        this._orbit.userData.target = orbit.target;
        this._orbit.userData.theta = Math.atan2(orbit.rvec.y, orbit.rvec.x);
        // console.log('theta ini:', this._orbit.userData.theta);

        this.scene.add(this._orbit);
        // console.log('this.scene:', this.scene);
    }
    _removeOrbit() {
        // console.log('this._orbit:', this._orbit);
        if (!this._orbit) return;

        this.scene.remove(this._orbit);
        this._orbit.geometry.dispose();
        this._orbit.material.dispose();
        this._orbit = null;
    }
    toggleOrbiting(tf) {
        this._isOrbiting = tf;
    }
    toggleGrids(tf) {
        this.scene.getObjectByName("singleton-walls").visible = tf;
        this.scene.getObjectByName("singleton-axes").visible = tf;
        this._render();
    }

    _doRaycast(mx, my) {
        return Viewer._applyWithMeshesVisible(
            this.objsInteractive, (meshes) =>
                this.threelet.raycastFromMouse(mx, my, meshes));
    }
    updateOrbit(mx, my) {
        let isect = this._doRaycast(mx, my);
        if (isect !== null) {
            // console.log('isect:', isect);
            let pt = isect.point;
            // console.log('pt (orbit):', pt);
            // console.log('meshHit:', isect.object.name);

            this._removeOrbit();
            this._addOrbit(Viewer._calcOrbit(this.camera, pt));
        } else {
            console.log('no isects (orbit)');
            this._removeOrbit();
            if (this.guiHelper) {
                this.guiHelper.autoOrbitController.setValue(false);
            }
        }

        if (this.guiHelper && !this.guiHelper.data.autoOrbit) this._render();
    }
    hasOrbit() {
        return this._orbit !== null;
    }
    setOrbitDefault() {
        this._removeOrbit();
        this._addOrbit(Viewer._calcOrbit(this.camera, new THREE.Vector3(0, 0, 0)));
    }

    //======== ======== ======== ========

    render() {
        if (this._isOrbiting && this._orbit) {
            let pt = this._orbit.userData.target;
            let radius = this._orbit.userData.radius;
            let theta = this._orbit.userData.theta;
            this.camera.position.setX(pt.x + radius * Math.cos(theta));
            this.camera.position.setY(pt.y + radius * Math.sin(theta));

            if (1) {
                this.camera.lookAt(pt.x, pt.y, pt.z);
            } else {
                // look along the tangent
                this.camera.lookAt(
                    pt.x + radius * Math.cos(theta + 0.01),
                    pt.y + radius * Math.sin(theta + 0.01),
                    this.camera.position.z);
            }

            this._orbit.userData.theta += 0.01;

            this.showMsg(this.camera);
        }
        this._render();
    }

    static toCoords(vec, nFloats=3) {
        return `(${vec.x.toFixed(nFloats)}, ${vec.y.toFixed(nFloats)}, ${vec.z.toFixed(nFloats)})`;
    }
    static toCoordsArray(vecArray) {
        return vecArray.map(vec => this.toCoords(vec)).join(', ');
    }
    static m2km(pt, unitsPerMeter) {
        return pt.clone().divideScalar(unitsPerMeter * 1000);
    }
    showMsg(cam) {
        const { unitsPerMeter } = this._projection;
        this.$msg.empty();
        this.$msg.append(`<div>pos [km]: ${Viewer.toCoords(Viewer.m2km(cam.position, unitsPerMeter))}</div>`);
        this.$msg.append(`<div>rot [rad]: ${Viewer.toCoords(cam.rotation)}</div>`);
    }
    showMsgTerrain() {
        const ll = this._origin;
        this.$msgTerrain.empty();
        this.$msgTerrain.append(`<div>lat lng: (${ll[0].toFixed(4)}, ${ll[1].toFixed(4)})</div>`);
        this.$msgTerrain.append(`<div>satellite zoom resolution [11-17]: ${this._zoom}</div>`);
    }

    //======== ======== ======== ========
    updateMode(vis) {
        this._vis = vis;
        this.scene.traverse((node) => {
            if (!(node instanceof THREE.Mesh) &&
                !(node instanceof THREE.Line)) return;

            // console.log(node.name);
            if (!node.name) return;

            if (node.name.startsWith('dem-rgb-')) {
                // console.log(`updating vis of ${node.name}`);
                if (vis === "Satellite" && node.name in this.satelliteMats) {
                    node.material = this.satelliteMats[node.name];
                    node.material.needsUpdate = true;
                    node.visible = true;
                } else if (vis === "Wireframe") {
                    node.material = this.wireframeMat;
                    node.material.needsUpdate = true;
                    node.visible = true;
                } else if (vis === "Contours") {
                    node.visible = false;
                }
            } else if (node.name.startsWith('dem-vec-')) {
                node.visible = vis === "Contours";
            }
        });
    }
    setGuiHelper(helper) {
        this.guiHelper = helper;
    }
    closeGui() {
        this.guiHelper.gui.close();
    }
    _render() {
        this.renderer.clear();
        this.renderer.render(this.scene, this.camera);
        this.renderer.clearDepth();
    }
    capture() {
        this.threelet.capture();
    }
}

class GuiHelper extends DatGuiDefaults {
    constructor(env, data, callbacks={}) {
        super(data);
        this.env = env;
        this.onChangeGrids = callbacks.onChangeGrids;
        this.onCapture = callbacks.onCapture;
        //----
        this.onChangeAutoOrbit = callbacks.onChangeAutoOrbit;
        this.onChangeVis = callbacks.onChangeVis;
        this.onChangeLeaflet = callbacks.onChangeLeaflet;
        this.onChangeLoc = callbacks.onChangeLoc;
    }

    // override
    initGui(gui, data, params) {
        this.locations = { // key: [lat, lng],
            "(none)": [0, 0], // dummy
            "Errinundra Plateau": [-37.30444, 148.90702],
            "Little River Gorge": [-37.07594, 148.31458],
            "Arbuckle": [-37.39956, 146.77146],
            "Cobbler": [-37.04308, 146.6219],
            "Mt Buffalo": [-36.75591, 146.79111],
            "Table Mountain": [-33.9625, 18.4107],
            "Eiger": [46.5763, 7.9904],
            "Colorado River": [36.2058, -112.4413],
            "Mount Fuji": [35.3778, 138.7472],
            "k2": [35.8818, 76.5142],
            // "Akagi": [36.5457, 139.1766],
            // "Cruach Ardrain": [56.3562, -4.5940],
            // "giza": [29.9791, 31.1342],
        };

        let controller;

        if (this.env.isDev) {
            controller = gui.add(params, 'isDev').name("isDev: true !!!!");
            controller.onChange((value) => {
                console.log('this.env:', this.env);
                if (1) {
                    const { origin, pathname } = window.location;
                    window.location.href = `${origin}${pathname}`;
                }
            });
        }

        let visItems = ["Satellite", "Wireframe", "Contours"];
        controller = gui.add(params, 'vis', visItems).name('Terrain');
        controller.onChange((value) => {
            this.onChangeVis(value);
            data.vis = value;
        });

        controller = gui.add(params, 'capture').name("Capture Now");
        controller.onChange((value) => {
            this.onCapture();
        });

        controller = gui.add(params, 'grids').name('Grids');
        controller.onChange((value) => {
            this.onChangeGrids(value);
            data.grids = value;
        });

        controller = gui.add(params, 'autoOrbit').name('Orbit');
        controller.onChange((value) => {
            this.onChangeAutoOrbit(value);
            data.autoOrbit = value;
        });
        this.autoOrbitController = controller;

        if (0) {
            controller = gui.add(params, 'reset').name("Reset");
            controller.onChange((value) => {
                this.applyDefaults();
                this.onChangeVis(params.vis);
                this.onChangeAutoOrbit(params.autoOrbit);

                Object.assign(data, params);
            });
        }

        controller = gui.add(params, 'loc',
            Object.keys(this.locations)).name('Location');
        controller.onChange((value) => {
            this.onChangeLoc(value, this.locations);
            data.Loc = value;
        });
    }
}

class App extends Threelet {
    // override
    onCreate(params) {
        this.camera.position.set(0, 0, 1.5);
        this.camera.up.set(0, 0, 1); // The up vector is along +z for this app

        const stats = this.setup('mod-stats', Stats, {panelType: 1});
        const viewer = new Viewer(env, this);

        this.render = () => { // override
            stats.update();
            this.resizeCanvas();
            viewer.render();
            viewer.showMsg(this.camera);
        };
        this.setup('mod-controls', THREE.OrbitControls);

        const guiData = App.createGuiData();
        viewer.setGuiHelper(
            App.createGuiHelper(env, guiData, viewer, this.render));

        // viewer.closeGui();
        viewer.showMsg(this.camera);
        viewer.showMsgTerrain();

        this.on('mouse-click-right', (mx, my) => viewer.updateOrbit(mx, my));

        this._appData = { stats, viewer, guiData };
    }

    static createGuiData() {
        const query = Viewer.parseQuery();
        return { // with defaults
            vis: query.mode,
            grids: true,
            autoOrbit: false,
            //----
            loc: query.title ? query.title.replace('_', ' ') : "",
            leaflet: true,
        };
    }
    static createAnimToggler(render) {
        let stopAnim = true;
        const animate = () => {
            if (stopAnim) {
                console.log('animate(): stopping');
                return;
            }
            requestAnimationFrame(animate);
            render();
        };

        return (tf) => {
            if (tf) {
                stopAnim = false;
                animate();
            } else {
                stopAnim = true;
            }
        };
    }
    static createGuiHelper(env, guiData, viewer, render) {
        const animToggler = this.createAnimToggler(render); // a closure
        const guiHelper = new GuiHelper(env, guiData, {
            onCapture: () => {
                viewer.capture();
            },
            onChangeGrids: (value) => {
                viewer.toggleGrids(value);
            },
            onChangeAutoOrbit: (value) => {
                viewer.toggleOrbiting(value);
                if (value) {
                    if (! viewer.hasOrbit()) {
                        viewer.setOrbitDefault();
                    }
                    console.log('starting anim...');
                    animToggler(true);
                } else {
                    console.log('stopping anim...');
                    animToggler(false);
                }
            },
            onChangeVis: (value) => {
                console.log('vis:', value);
                if (value === 'Contours') {
                    viewer.loadVectorDem(() => {
                        viewer.updateMode(value);
                        render();
                    });
                } else {
                    viewer.loadRgbDem(() => {
                        viewer.updateMode(value);
                        render();
                    });
                }
            },
            onChangeLoc: (value, locations) => {
                if (value === "(none)") { // dummy case
                    return;
                }

                if (value in locations) {
                    let title = value.replace(' ', '_');
                    let ll = locations[value];
                    viewer.reloadPageWithLocation(ll, title);
                }
            },
        });
        guiHelper.setDefaults({
            isDev: () => {},
            vis: guiData.vis,
            capture: () => {},
            grids: guiData.grids,
            //----
            autoOrbit: guiData.autoOrbit,
            reset: () => {},
            //----
            loc: guiData.loc,
            leaflet: guiData.leaflet,
            sourceCode: () => {},
        });
        return guiHelper;
    }
}

const app = new App({
    canvas: document.getElementById("canvas"),
});
app.render(); // first time