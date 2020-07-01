const { THREE, Threelet, Stats, DatGuiDefaults, jQuery: $ } = window;

// import L from 'leaflet';
// import * as turfHelpers from '@turf/helpers';
// import turfDistance from '@turf/distance';
// import turfCircle from '@turf/circle/index';

// import { GeoSearchControl, OpenStreetMapProvider } from 'leaflet-geosearch';

const env = {
    zoom: 13, // satellite zoom resolution -- min: 11, defaut: 13, max: 17
    enableTilesLeaflet: true,
    tokenMapbox: 'pk.eyJ1IjoidGhvbXBzb25maWxtIiwiYSI6ImNrYzFhdXV6NTByZ2EydG9lODc4Y2V3b2QifQ.qwJLT2-CkC52qmsWxQ3e1g', // <---- set your Mapbox API token here
};

class Viewer {
    constructor(env, threelet) {
        this.env = env;

        const { camera, renderer } = threelet;
        this.threelet = threelet;
        this.camera = camera;
        this.renderer = renderer;

        this.guiHelper = null;

        this.scene = new THREE.Scene();
        this.sceneMeasure = new THREE.Scene();

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

        //======== add laser
        this._laser = new ThreeGeo.Laser({
            color: 0xffffff,
        });
        this._laser.name = 'singleton-laser-vr';
        this.scene.add(this._laser);

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
        this.$msgMeasure = $('#msgMeasure');
        this.$msgTerrain = $('#msgTerrain');

        // tmp laser for measurement
        this._laserMarkTmp = new ThreeGeo.Laser({maxPoints: 2});
        this._laserMarkTmp.name = 'singleton-measure-mark-tmp';
        this.sceneMeasure.add(this._laserMarkTmp);

        this.markPair = []; // now this.markPair.length === 0
        this._laserMarkColor = null;

        // ------- marker stuff
        this._laserMarker = new ThreeGeo.Laser({maxPoints: 2});
        this._laserMarker.visible = false;
        this._laserMarker.name = 'singleton-marker';
        this.scene.add(this._laserMarker);

        // ------- orbit stuff -------
        this._orbit = null;
        this._isOrbiting = false;

        this._showVrLaser = false;
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
            // _origin = [36.2058, -112.4413];
            // _parsedQ.title = "Colorado River";
            _origin = [-33.9625, 18.4107];
            _title = "Table Mountain";
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
        //::::Laser ""     orbit           vv   this._updateLaserMarker(null)
        //::::LineLoop ""  orbit           vv   this._removeOrbit()
        //::::Laser ""     pointer            intact
        //========
        this.scene.children.filter(
            obj => obj.name.startsWith('dem-'))
                .forEach(dem => {
                    dem.parent.remove(dem);
                    Viewer._disposeObject(dem);
                });
        //--
        this._updateLaserMarker(null);
        //--
        this._removeOrbit();
        if (this.guiHelper) {
            this.guiHelper.autoOrbitController.setValue(false);
        }
        //--

        // this.sceneMeasure.children
        //::::Laser ""     this._laserMarkTmp   vv   this._updateLaserMarkTmp(null)
        //::::Laser ""     measure         vv   to be cleared
        //::::Laser ""     measure         vv   to be cleared
        //...                              vv
        //========
        this._updateLaserMarkTmp(null);
        //--
        this.sceneMeasure.children.filter(
            obj => obj.name.startsWith('measure-mark-'))
                .forEach(mark => {
                    mark.parent.remove(mark);
                    Viewer._disposeObject(mark);
                });
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
                console.log('this.sceneMeasure.children:', this.sceneMeasure.children);
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
            onRgbDem: (objs) => {
                // dem-rgb-<zoompos>
                objs.forEach((obj) => {
                    this.objsInteractive.push(obj);
                    this.scene.add(obj);
                    // console.log('obj:', obj);
                });
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

    // marker stuff --------
    _updateLaserMarker(pt=null) {
        if (pt) {
            this._laserMarker.setSource(pt);
            this._laserMarker.point(pt.clone().setZ(pt.z + 1.0), 0xff00ff);
            this._laserMarker.visible = true;
        } else {
            this._laserMarker.clearPoints();
            this._laserMarker.visible = false;
        }
    }
    _updateLaserMarkTmp(pt0=null, pt1=null, color=0xffffff) {
        if (pt0) {
            this._laserMarkTmp.setSource(pt0);
            this._laserMarkTmp.point(pt1, color);
            this._laserMarkTmp.visible = true;
        } else {
            this.markPair.length = 0; // now this.markPair.length === 0
            this._laserMarkTmp.visible = false;
        }
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
    toggleVrLaser(tf) {
        this._showVrLaser = tf;
    }
    toggleGrids(tf) {
        this.scene.getObjectByName("singleton-walls").visible = tf;
        this.scene.getObjectByName("singleton-axes").visible = tf;
        this._render();
    }

    // laser casting stuff --------
    static _applyWithMeshesVisible(meshes, func) {
        // console.log('meshes:', meshes);

        // save mesh visibilities
        let visibilities = {};
        meshes.forEach((mesh) => {
            visibilities[mesh.uuid] = mesh.visible; // save
            mesh.visible = true; // forcing for raycast
        });

        let output = func(meshes);

        // restore mesh visibilities
        meshes.forEach((mesh) => {
            mesh.visible = visibilities[mesh.uuid]; // restore
        });

        return output;
    }
    _doRaycast(mx, my) {
        return Viewer._applyWithMeshesVisible(
            this.objsInteractive, (meshes) =>
                this.threelet.raycastFromMouse(mx, my, meshes));
    }

    updateMeasure(mx, my) {
        let isect = this._doRaycast(mx, my);
        if (isect !== null) {
            // console.log('isect:', isect);
            let pt = isect.point;
            // console.log('pt (measure):', pt);
            if (this.markPair.length === 1) {
                this.markPair.push(pt); // now this.markPair.length === 2
                // console.log('registering this.markPair:', this.markPair);
                let laser = new ThreeGeo.Laser({
                    maxPoints: 2,
                    color: this._laserMarkColor,
                });
                laser.updatePoints(this.markPair);
                laser.name = `measure-mark-${Date.now()}`;
                this.sceneMeasure.add(laser);
            } else { // when this.markPair.length === 0 or 2
                this.markPair = [pt,]; // now this.markPair.length === 1
                this._laserMarkColor = 0x00ffff;
                // get a new random color
                // this._laserMarkColor = Math.floor(0xffffff * Math.random());
                // console.log('new color:', this._laserMarkColor);
            }
            // console.log('this.markPair:', this.markPair);
        } else {
            this._updateLaserMarkTmp(null); // now this.markPair.length === 0
        }

        if (this.guiHelper && !this.guiHelper.data.autoOrbit) this._render();

        this.showMeasureStats(this.markPair);
    }
    updateOrbit(mx, my) {
        let isect = this._doRaycast(mx, my);
        if (isect !== null) {
            // console.log('isect:', isect);
            let pt = isect.point;
            // console.log('pt (orbit):', pt);
            // console.log('meshHit:', isect.object.name);

            this._updateLaserMarker(pt);
            this._removeOrbit();
            this._addOrbit(Viewer._calcOrbit(this.camera, pt));
        } else {
            console.log('no isects (orbit)');
            this._updateLaserMarker(null);
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
    pick(mx, my) {
        if (!this._showVrLaser && this.markPair.length !== 1) {
            return;
        }

        let isect = this._doRaycast(mx, my);
        if (isect !== null) {
            // console.log('isect:', isect);
            let pt = isect.point;
            // console.log('pt:', pt);

            let ptSrc = new THREE.Vector3(0.003, -0.004, 0.002);
            this._laser.setSource(ptSrc, this.camera);
            if (this._showVrLaser) {
                // this._laser.point(pt, 0xffffff);
                //----
                Viewer._applyWithMeshesVisible(
                    this.objsInteractive, (meshes) =>
                        this._laser.pointWithRaytrace(pt, meshes, 0xffffff, 16));
            }

            if (this.markPair.length === 1) {
                this._updateLaserMarkTmp(this.markPair[0], pt, this._laserMarkColor);
            } else {
                this._updateLaserMarkTmp(null); // now this.markPair.length === 0
            }
        } else {
            // console.log('no isects');
            this._laser.clearPoints();
        }

        if (this.guiHelper && !this.guiHelper.data.autoOrbit) this._render();

        // = 1(src point) + #(reflection points) + 1(end point)
        // console.log('#points:', this._laser.getPoints().length);
    }
    clearPick() {
        this._laser.clearPoints();
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
    showMeasureStats(_markPair) {
        const { unitsPerMeter } = this._projection;
        this.$msgMeasure.empty();
        if (_markPair.length === 1) {
            this.$msgMeasure.append(`<div>points: ${Viewer.toCoords(Viewer.m2km(_markPair[0], unitsPerMeter))} -> </div>`);
        } else if (_markPair.length === 2) {
            const p0km = Viewer.m2km(_markPair[0], unitsPerMeter);
            const p1km = Viewer.m2km(_markPair[1], unitsPerMeter);
            this.$msgMeasure.append(`<div>points: ${Viewer.toCoords(p0km)} -> ${Viewer.toCoords(p1km)}</div>`);
            this.$msgMeasure.append(`<div>euclidean dist: ${p0km.distanceTo(p1km).toFixed(3)}</div>`);
        }
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
        this.renderer.render(this.sceneMeasure, this.camera);
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
        this.onChangeVrLaser = callbacks.onChangeVrLaser;
        this.onChangeLeaflet = callbacks.onChangeLeaflet;
        this.onChangeLoc = callbacks.onChangeLoc;
    }

    // override
    initGui(gui, data, params) {
        this.locations = { // key: [lat, lng],
            "(none)": [0, 0], // dummy
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

        controller = gui.add(params, 'vrLaser').name('Laser');
        controller.onChange((value) => {
            this.onChangeVrLaser(value);
            data.vrLaser = value;
        });

        if (0) {
            controller = gui.add(params, 'reset').name("Reset");
            controller.onChange((value) => {
                this.applyDefaults();
                this.onChangeVis(params.vis);
                this.onChangeAutoOrbit(params.autoOrbit);
                this.onChangeVrLaser(value);

                Object.assign(data, params);
            });
        }

        controller = gui.add(params, 'leaflet').name('Map');
        controller.onChange((value) => {
            this.onChangeLeaflet(value);
            data.leaflet = value;
        });

        controller = gui.add(params, 'loc',
            Object.keys(this.locations)).name('Location');
        controller.onChange((value) => {
            this.onChangeLoc(value, this.locations);
            data.Loc = value;
        });

        controller = gui.add(params, 'sourceCode').name("Source Code");
        controller.onChange((value) => {
            window.location.href = "https://github.com/w3reality/three-geo/tree/master/examples/geo-viewer";
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

        this.on('mouse-move', (mx, my) => viewer.pick(mx, my));
        this.on('mouse-click', (mx, my) => viewer.updateMeasure(mx, my));
        this.on('mouse-click-right', (mx, my) => viewer.updateOrbit(mx, my));

        this._appData = { stats, viewer, guiData };
    }

    static createGuiData() {
        const query = Viewer.parseQuery();
        return { // with defaults
            vis: query.mode,
            grids: true,
            autoOrbit: false,
            vrLaser: false,
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
            onChangeVrLaser: (value) => {
                viewer.toggleVrLaser(value);
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
            vrLaser: guiData.vrLaser,
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