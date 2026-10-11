// The Earth made of names.
//
// Two textured layers, both painted with the 2D canvas so any script or
// accent renders exactly as the browser would print it:
//
//   base    one texture for the whole planet, always present
//   detail  a second, sharper texture covering only what the camera is
//           looking at, repainted as the view moves; this is what lets names
//           stay crisp at any zoom without ever drawing the whole collection
//
// Empty places are drawn as rows of dim dots in the Earth's colours, so the
// planet is complete from the first day and no name is ever invented to fill it.

import * as THREE from "three";
import { earthColor, type RGB } from "../shared/earth";
import {
	BASE_CELLS,
	LAT_MAX,
	ROWS,
	ROW_H,
	type Rect,
	capacity,
	colsInRow,
	currentLevel,
	firstCellInRow,
	slotAt,
	slotAtPoint,
	slotRect,
} from "../shared/grid";
import type { Stats } from "../shared/text";
import { getNames } from "./api";
import { demoName } from "./demo";

const FOV = 38;
const TAN_HALF = Math.tan((FOV / 2) * (Math.PI / 180));
const RAD = Math.PI / 180;
const FONT = '"Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
/** Slots below this are fetched in one request: the first names are large enough to read from far away. */
const OVERVIEW_SLOTS = BASE_CELLS * 4;
const CRUISE_ALTITUDE = 11;
const GOLD = "#ffe7a3";

type View = { lat: number; lon: number; alt: number };
type Span = { lat0: number; lat1: number; lon0: number; lon1: number };
type Flight = { from: View; to: View; start: number; duration: number; cinematic: boolean; done: () => void };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (lo: number, hi: number, v: number) => {
	const t = clamp((v - lo) / (hi - lo), 0, 1);
	return t * t * (3 - 2 * t);
};
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

function direction(lat: number, lon: number, out = new THREE.Vector3()) {
	const c = Math.cos(lat * RAD);
	return out.set(c * Math.sin(lon * RAD), Math.sin(lat * RAD), c * Math.cos(lon * RAD));
}

/** A patch of sphere covering a latitude/longitude rectangle, with UVs spanning the rectangle. */
function patchGeometry(span: Span, radius: number, segments: number) {
	const positions: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];
	const v = new THREE.Vector3();
	for (let j = 0; j <= segments; j++) {
		for (let i = 0; i <= segments; i++) {
			const lat = span.lat0 + ((span.lat1 - span.lat0) * j) / segments;
			const lon = span.lon0 + ((span.lon1 - span.lon0) * i) / segments;
			direction(lat, lon, v).multiplyScalar(radius);
			positions.push(v.x, v.y, v.z);
			uvs.push(i / segments, j / segments);
		}
	}
	for (let j = 0; j < segments; j++) {
		for (let i = 0; i < segments; i++) {
			const a = j * (segments + 1) + i;
			indices.push(a, a + 1, a + segments + 1, a + 1, a + segments + 2, a + segments + 1);
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
	geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
	geometry.setIndex(indices);
	return geometry;
}

const SURFACE_VERTEX = `
	varying vec2 vUv;
	varying vec3 vNormal;
	varying vec3 vView;
	void main() {
		vUv = uv;
		vec4 mv = modelViewMatrix * vec4(position, 1.0);
		vNormal = normalize(normalMatrix * normalize(position));
		vView = normalize(-mv.xyz);
		gl_Position = projectionMatrix * mv;
	}`;

// Soft key light from the upper left of the viewer, plus a thin blue rim: restrained, never theatrical.
const SURFACE_FRAGMENT = `
	uniform sampler2D map;
	uniform float uDim;
	uniform float uOpacity;
	varying vec2 vUv;
	varying vec3 vNormal;
	varying vec3 vView;
	void main() {
		vec3 color = texture2D(map, vUv).rgb;
		float light = 0.74 + 0.38 * max(dot(vNormal, normalize(vec3(-0.45, 0.5, 0.75))), 0.0);
		float rim = pow(1.0 - max(dot(vNormal, vView), 0.0), 3.0);
		color = color * light * uDim + vec3(0.2, 0.45, 0.9) * rim * 0.4;
		gl_FragColor = vec4(color, uOpacity);
	}`;

const rgb = (c: RGB, scale = 1, lift = 0) =>
	`rgb(${Math.round(c[0] * scale + (255 - c[0]) * lift)},${Math.round(c[1] * scale + (255 - c[1]) * lift)},${Math.round(c[2] * scale + (255 - c[2]) * lift)})`;

export type GlobeOptions = {
	reducedMotion: boolean;
	/** A name was clicked or tapped. `sample` is true for demonstration names. */
	onPick: (slot: number, sample: boolean) => void;
};

export class Globe {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 2000);
	private view: View = { lat: 18, lon: -30, alt: 4 };
	private velocity = { lat: 0, lon: 0 };
	private flight: Flight | null = null;
	private raf = 0;
	private last = performance.now();
	private lastTouch = performance.now();
	private disposed = false;

	private earthImage: HTMLCanvasElement;
	private baseCanvas = document.createElement("canvas");
	private baseTexture: THREE.CanvasTexture;
	private baseMaterial: THREE.ShaderMaterial;
	private detailCanvas = document.createElement("canvas");
	private detailTexture: THREE.CanvasTexture;
	private detailMaterial: THREE.ShaderMaterial;
	private detailMesh: THREE.Mesh;
	private detailSpan: Span | null = null;
	private detailDirty = true;
	private detailTimer = 0;
	private glowMesh: THREE.Mesh;
	private glowCanvas = document.createElement("canvas");
	private glowTexture: THREE.CanvasTexture;
	private hoverMesh: THREE.Mesh;
	private stars: THREE.Points;

	private slots = 0;
	private realSlots = 0;
	private vacant = new Set<number>();
	private level = 0;
	private names = new Map<number, string>();
	private loadedCells = new Set<number>();
	private wantedCells = new Set<number>();
	private fetching = false;
	private widths = new Map<string, number>();
	private focusSlot = -1;
	private focusLabel = "";
	private glow = 0;
	private glowTarget = 0;
	private dim = 1;
	private hoverSlot = -1;
	private pointers = new Map<number, { x: number; y: number }>();
	private press: { x: number; y: number; time: number; moved: boolean } | null = null;
	private pinch = 0;
	private small: boolean;
	private observer: ResizeObserver;

	constructor(
		private container: HTMLElement,
		private options: GlobeOptions,
	) {
		this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
		this.renderer.setClearColor(0x02030a);
		this.renderer.domElement.className = "nf-canvas";
		container.appendChild(this.renderer.domElement);

		this.small = Math.min(window.innerWidth, window.innerHeight) < 700 || this.renderer.capabilities.maxTextureSize < 4096;
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.small ? 1.5 : 2));

		// The Earth's colours as an image, used as a faint wash beneath the dots and names.
		this.earthImage = document.createElement("canvas");
		this.earthImage.width = 720;
		this.earthImage.height = 360;
		const ectx = this.earthImage.getContext("2d")!;
		const pixels = ectx.createImageData(720, 360);
		for (let y = 0; y < 360; y++) {
			for (let x = 0; x < 720; x++) {
				const c = earthColor(90 - (y + 0.5) / 2, -180 + (x + 0.5) / 2);
				pixels.data.set([c[0], c[1], c[2], 255], (y * 720 + x) * 4);
			}
		}
		ectx.putImageData(pixels, 0, 0);

		const surface = (texture: THREE.Texture, transparent: boolean) =>
			new THREE.ShaderMaterial({
				uniforms: { map: { value: texture }, uDim: { value: 1 }, uOpacity: { value: transparent ? 0 : 1 } },
				vertexShader: SURFACE_VERTEX,
				fragmentShader: SURFACE_FRAGMENT,
				transparent,
			});
		const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
		const canvasTexture = (canvas: HTMLCanvasElement) => {
			const texture = new THREE.CanvasTexture(canvas);
			texture.anisotropy = anisotropy;
			texture.wrapS = THREE.ClampToEdgeWrapping;
			return texture;
		};

		this.baseCanvas.width = this.small ? 2048 : 4096;
		this.baseCanvas.height = this.baseCanvas.width / 2;
		this.baseTexture = canvasTexture(this.baseCanvas);
		this.baseMaterial = surface(this.baseTexture, false);
		this.scene.add(new THREE.Mesh(patchGeometry({ lat0: -90, lat1: 90, lon0: -180, lon1: 180 }, 1, 96), this.baseMaterial));

		this.detailCanvas.width = this.detailCanvas.height = this.small ? 1024 : 2048;
		this.detailTexture = canvasTexture(this.detailCanvas);
		this.detailMaterial = surface(this.detailTexture, true);
		this.detailMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.detailMaterial);
		this.detailMesh.visible = false;
		this.scene.add(this.detailMesh);

		this.glowTexture = canvasTexture(this.glowCanvas);
		this.glowTexture.colorSpace = THREE.SRGBColorSpace;
		this.glowMesh = new THREE.Mesh(
			new THREE.BufferGeometry(),
			new THREE.MeshBasicMaterial({ map: this.glowTexture, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
		);
		this.glowMesh.visible = false;
		this.scene.add(this.glowMesh);

		const hoverCanvas = document.createElement("canvas");
		hoverCanvas.width = 512;
		hoverCanvas.height = 96;
		const hctx = hoverCanvas.getContext("2d")!;
		hctx.fillStyle = "rgba(255, 231, 163, 0.12)";
		hctx.strokeStyle = "rgba(255, 231, 163, 0.9)";
		hctx.lineWidth = 3;
		hctx.beginPath();
		hctx.roundRect(3, 3, 506, 90, 18);
		hctx.fill();
		hctx.stroke();
		this.hoverMesh = new THREE.Mesh(
			new THREE.BufferGeometry(),
			new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(hoverCanvas), transparent: true, depthWrite: false, toneMapped: false }),
		);
		this.hoverMesh.visible = false;
		this.scene.add(this.hoverMesh);

		// Atmosphere: a soft blue halo just outside the planet.
		this.scene.add(
			new THREE.Mesh(
				new THREE.SphereGeometry(1.13, 64, 48),
				new THREE.ShaderMaterial({
					vertexShader: `varying vec3 vNormal; void main() { vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
					fragmentShader: `varying vec3 vNormal; void main() { float i = pow(max(0.62 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0), 3.2); gl_FragColor = vec4(0.32, 0.6, 1.0, 1.0) * i * 1.6; }`,
					side: THREE.BackSide,
					blending: THREE.AdditiveBlending,
					transparent: true,
					depthWrite: false,
				}),
			),
		);

		this.stars = this.makeStars();
		this.scene.add(this.stars);

		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(container);
		this.resize();
		this.view.alt = this.homeAltitude();
		this.listen();
		this.paintBase();
		this.raf = requestAnimationFrame(this.tick);
	}

	// ------------------------------------------------------------------ data

	/** Real slot counts from the server, plus how many sample names to show beyond them (0 for none). */
	setStats(stats: Stats, sampleCount: number) {
		this.realSlots = stats.slots;
		this.slots = Math.max(stats.slots, sampleCount);
		this.vacant = new Set(stats.vacant);
		this.level = currentLevel(this.slots);
		this.loadedCells.clear();
		if (stats.slots > 0) {
			getNames(`below=${OVERVIEW_SLOTS}`).then((rows) => {
				for (const [slot, name] of rows) this.names.set(slot, name);
				this.paintBase();
				this.detailDirty = true;
			}, () => {});
		}
		this.paintBase();
		this.detailDirty = true;
		if (this.focusSlot >= 0) this.paintGlow();
	}

	private filled(slot: number) {
		return slot >= 0 && slot < this.slots && !this.vacant.has(slot);
	}

	private nameOf(slot: number) {
		return slot >= this.realSlots ? demoName(slot) : this.names.get(slot);
	}

	private async fetchCells() {
		if (this.fetching || !this.wantedCells.size) return;
		this.fetching = true;
		const cells = [...this.wantedCells].slice(0, 90);
		try {
			for (const [slot, name] of await getNames(`cells=${cells.join(",")}`)) this.names.set(slot, name);
			for (const cell of cells) this.loadedCells.add(cell);
			this.detailDirty = true;
		} catch {
			// Leave the cells unloaded; the next repaint asks again.
		}
		for (const cell of cells) this.wantedCells.delete(cell);
		this.fetching = false;
		if (!this.disposed) void this.fetchCells();
	}

	// -------------------------------------------------------------- painting

	private textWidth(ctx: CanvasRenderingContext2D, name: string, size: number) {
		let unit = this.widths.get(name);
		if (unit === undefined) {
			if (this.widths.size > 60000) this.widths.clear();
			unit = ctx.measureText(name).width / size;
			this.widths.set(name, unit);
		}
		return unit * size;
	}

	/** Paints one latitude/longitude rectangle of the Earth into a canvas. */
	private paint(ctx: CanvasRenderingContext2D, W: number, H: number, span: Span, fetchMissing: boolean) {
		const perLon = W / (span.lon1 - span.lon0);
		const perLat = H / (span.lat1 - span.lat0);
		const px = (lon: number) => (lon - span.lon0) * perLon;
		const py = (lat: number) => (span.lat1 - lat) * perLat;
		const n = 2 ** this.level;
		const h = (ROW_H / n) * perLat;
		const dense = h < 1.2;

		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalAlpha = 1;
		ctx.fillStyle = "#03050c";
		ctx.fillRect(0, 0, W, H);
		ctx.imageSmoothingEnabled = true;
		// When individual places are smaller than a pixel the wash carries the image, weighted by how full the Earth is.
		ctx.globalAlpha = dense ? 0.3 + 0.55 * Math.min(1, this.slots / capacity(this.level)) : 0.2;
		for (let k = -1; k <= 1; k++) ctx.drawImage(this.earthImage, px(-180 + 360 * k), py(90), 360 * perLon, 180 * perLat);
		ctx.globalAlpha = 1;
		if (dense) return;

		const readable = h * 0.72 >= 5;
		const size = h * 0.72;
		ctx.font = `600 ${size}px ${FONT}`;
		ctx.textBaseline = "middle";
		const subLat = ROW_H / n;
		const row0 = clamp(Math.floor((span.lat0 + LAT_MAX) / ROW_H), 0, ROWS - 1);
		const row1 = clamp(Math.floor((span.lat1 + LAT_MAX) / ROW_H), 0, ROWS - 1);

		for (let row = row0; row <= row1; row++) {
			const cols = colsInRow(row);
			const cellLon = 360 / cols;
			const subLon = cellLon / n;
			const w = subLon * perLon;
			const rowLat = -LAT_MAX + row * ROW_H;
			// Longitude degrees shrink toward the poles; stretch text in the texture so it looks right on the sphere.
			const stretch = perLon / perLat / Math.cos((rowLat + ROW_H / 2) * RAD);
			const dot = Math.max(0.6, h * 0.17);
			const dots = Math.max(1, Math.round(w / (h * stretch)));
			const y0 = clamp(Math.floor(((span.lat0 - rowLat) / ROW_H) * n), 0, n - 1);
			const y1 = clamp(Math.floor(((span.lat1 - rowLat) / ROW_H) * n), 0, n - 1);

			for (let c = Math.floor((span.lon0 + 180) / cellLon); c <= Math.floor((span.lon1 + 180) / cellLon); c++) {
				const cell = firstCellInRow(row) + (((c % cols) + cols) % cols);
				const lonCell = -180 + c * cellLon;
				if (fetchMissing && readable && this.realSlots > OVERVIEW_SLOTS && !this.loadedCells.has(cell)) this.wantedCells.add(cell);
				const x0 = clamp(Math.floor((span.lon0 - lonCell) / subLon), 0, n - 1);
				const x1 = clamp(Math.floor((span.lon1 - lonCell) / subLon), 0, n - 1);

				for (let y = y0; y <= y1; y++) {
					const lat = rowLat + (y + 0.5) * subLat;
					const top = py(rowLat + (y + 1) * subLat);
					for (let x = x0; x <= x1; x++) {
						const left = px(lonCell + x * subLon);
						const slot = slotAt(cell, this.level, x, y);
						if (!this.filled(slot)) {
							// An open place: a row of dim dots in the Earth's own colours.
							for (let d = 0; d < dots; d++) {
								const fx = (d + 0.5) / dots;
								ctx.fillStyle = rgb(earthColor(lat, lonCell + (x + fx) * subLon), 0.5);
								if (h < 5) ctx.fillRect(left + fx * w - dot, top + h / 2 - dot, dot * 2, dot * 2);
								else {
									ctx.beginPath();
									ctx.ellipse(left + fx * w, top + h / 2, dot * stretch, dot, 0, 0, Math.PI * 2);
									ctx.fill();
								}
							}
							continue;
						}
						const color = earthColor(lat, lonCell + (x + 0.5) * subLon);
						const name = readable ? this.nameOf(slot) : undefined;
						if (!name) {
							// A name too small to read from here (or still loading): a bright stroke.
							ctx.fillStyle = rgb(color, 1, 0.1);
							ctx.fillRect(left + w * 0.06, top + h * 0.3, w * 0.86, Math.max(1, h * 0.4));
							continue;
						}
						const fit = Math.min(1, (w * 0.92) / (this.textWidth(ctx, name, size) * stretch));
						ctx.fillStyle = rgb(color, 1, 0.2);
						ctx.setTransform(stretch * fit, 0, 0, fit, left + w * 0.04, top + h / 2);
						ctx.fillText(name, 0, 0);
						ctx.setTransform(1, 0, 0, 1, 0, 0);
					}
				}
			}
		}
		if (fetchMissing) void this.fetchCells();
	}

	private paintBase() {
		const ctx = this.baseCanvas.getContext("2d")!;
		this.paint(ctx, this.baseCanvas.width, this.baseCanvas.height, { lat0: -90, lat1: 90, lon0: -180, lon1: 180 }, false);
		this.baseTexture.needsUpdate = true;
	}

	/** How far (in degrees) the camera can see from the point beneath it. */
	private visibleRadius() {
		const dist = 1 + this.view.alt;
		const half = Math.atan(TAN_HALF * Math.hypot(1, this.camera.aspect));
		const s = dist * Math.sin(half);
		return (s < 1 ? Math.asin(s) - half : Math.acos(1 / dist)) / RAD;
	}

	private updateDetail(now: number) {
		const radius = this.visibleRadius();
		if (radius > 40) {
			this.detailMaterial.uniforms.uOpacity.value = Math.max(0, this.detailMaterial.uniforms.uOpacity.value - 0.08);
			if (this.detailMaterial.uniforms.uOpacity.value === 0) {
				this.detailMesh.visible = false;
				this.detailSpan = null;
			}
			return;
		}
		const widen = 1 / Math.max(0.12, Math.cos(this.view.lat * RAD));
		const s = this.detailSpan;
		const covered =
			s &&
			this.view.lat - radius >= s.lat0 &&
			this.view.lat + radius <= s.lat1 &&
			this.view.lon - radius * widen >= s.lon0 &&
			this.view.lon + radius * widen <= s.lon1 &&
			s.lat1 - s.lat0 < radius * 5.5;
		if ((!covered || this.detailDirty) && now - this.detailTimer > 140) {
			this.detailTimer = now;
			this.detailDirty = false;
			const reach = radius * 1.25;
			const lat0 = Math.max(-89, this.view.lat - reach);
			const lat1 = Math.min(89, this.view.lat + reach);
			// Re-centre on the current longitude each time so the span never drifts far past ±180.
			this.view.lon = wrapLon(this.view.lon);
			const span = { lat0, lat1, lon0: this.view.lon - reach * widen, lon1: this.view.lon + reach * widen };
			this.paint(this.detailCanvas.getContext("2d")!, this.detailCanvas.width, this.detailCanvas.height, span, true);
			this.detailTexture.needsUpdate = true;
			this.detailMesh.geometry.dispose();
			this.detailMesh.geometry = patchGeometry(span, 1.0002, 48);
			this.detailMesh.visible = true;
			this.detailSpan = span;
		}
		if (this.detailMesh.visible) {
			this.detailMaterial.uniforms.uOpacity.value = Math.min(1, this.detailMaterial.uniforms.uOpacity.value + 0.1);
		}
	}

	private rectSpan(rect: Rect): Span {
		return { lat0: rect.lat0, lat1: rect.lat0 + rect.dLat, lon0: rect.lon0, lon1: rect.lon0 + rect.dLon };
	}

	/** The selected name, redrawn in gold on its own small surface so it glows above the rest. */
	private paintGlow() {
		const rect = slotRect(this.focusSlot, this.level);
		const aspect = (rect.dLon * Math.cos((rect.lat0 + rect.dLat / 2) * RAD)) / rect.dLat;
		const W = 1024;
		const H = Math.max(64, Math.round(W / aspect));
		this.glowCanvas.width = W;
		this.glowCanvas.height = H;
		const ctx = this.glowCanvas.getContext("2d")!;
		ctx.fillStyle = "rgba(3, 5, 12, 0.92)";
		ctx.fillRect(0, 0, W, H);
		const size = H * 0.72;
		ctx.font = `600 ${size}px ${FONT}`;
		ctx.textBaseline = "middle";
		const fit = Math.min(1, (W * 0.92) / ctx.measureText(this.focusLabel).width);
		ctx.setTransform(fit, 0, 0, fit, W * 0.04, H / 2);
		ctx.shadowColor = "rgba(255, 196, 92, 0.95)";
		ctx.shadowBlur = H * 0.28;
		ctx.fillStyle = GOLD;
		ctx.fillText(this.focusLabel, 0, 0);
		ctx.fillText(this.focusLabel, 0, 0);
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		this.glowTexture.dispose();
		this.glowTexture.needsUpdate = true;
		this.glowMesh.geometry.dispose();
		this.glowMesh.geometry = patchGeometry(this.rectSpan(rect), 1.0004, 6);
		this.glowMesh.visible = true;
	}

	private makeStars() {
		const positions: number[] = [];
		const colors: number[] = [];
		const v = new THREE.Vector3();
		const add = (count: number, near: number, far: number, bright: number) => {
			for (let i = 0; i < count; i++) {
				v.randomDirection().multiplyScalar(near + Math.random() * (far - near));
				positions.push(v.x, v.y, v.z);
				const b = bright * (0.35 + Math.random() * 0.65);
				const warm = Math.random();
				colors.push(b * (0.8 + 0.2 * warm), b * 0.88, b * (1 - 0.25 * warm));
			}
		};
		add(this.small ? 2500 : 5000, 400, 900, 1);
		// Nearer points of light the camera passes among during the journey.
		add(this.small ? 1200 : 2600, 7, 70, 0.9);
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
		geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
		return new THREE.Points(
			geometry,
			new THREE.PointsMaterial({ size: 1.7, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }),
		);
	}

	// ---------------------------------------------------------------- camera

	private homeAltitude() {
		// Far enough that the planet fills most of the shorter side of the screen.
		const fill = Math.min(0.6, 0.86 * this.camera.aspect);
		return 1 / Math.sin(Math.atan(fill * TAN_HALF)) - 1;
	}

	private nameWidth() {
		return ((360 / 32 / 2 ** this.level) * RAD);
	}

	/** The altitude at which one name spans the given fraction of the screen's width. */
	private altitudeFor(fraction: number) {
		return this.nameWidth() / (fraction * 2 * TAN_HALF * this.camera.aspect);
	}

	private resize() {
		const { clientWidth: w, clientHeight: h } = this.container;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	private placeCamera() {
		const dist = 1 + this.view.alt;
		direction(this.view.lat, this.view.lon, this.camera.position).multiplyScalar(dist);
		this.camera.near = Math.max(0.00005, this.view.alt * 0.3);
		this.camera.far = 2000;
		this.camera.updateProjectionMatrix();
		this.camera.lookAt(0, 0, 0);
	}

	private tick = (now: number) => {
		if (this.disposed) return;
		const dt = Math.min(0.05, (now - this.last) / 1000);
		this.last = now;

		if (this.flight) this.advanceFlight(now);
		else {
			if (!this.pointers.size) {
				this.view.lat = clamp(this.view.lat + this.velocity.lat * dt, -85, 85);
				this.view.lon += this.velocity.lon * dt;
				const decay = Math.exp(-4 * dt);
				this.velocity.lat *= decay;
				this.velocity.lon *= decay;
				const idle = now - this.lastTouch > 5000 && this.focusSlot < 0 && this.view.alt > this.homeAltitude() * 0.85;
				if (idle && !this.options.reducedMotion) this.view.lon += 1.1 * dt;
			}
		}

		this.glow += (this.glowTarget - this.glow) * Math.min(1, dt * 5);
		(this.glowMesh.material as THREE.MeshBasicMaterial).opacity = this.glow;
		const dimTarget = this.focusSlot >= 0 ? 1 - 0.42 * this.glowTarget : 1;
		this.dim += (dimTarget - this.dim) * Math.min(1, dt * 4);
		this.baseMaterial.uniforms.uDim.value = this.dim;
		this.detailMaterial.uniforms.uDim.value = this.dim;

		this.placeCamera();
		this.updateDetail(now);
		this.renderer.render(this.scene, this.camera);
		this.raf = requestAnimationFrame(this.tick);
	};

	private advanceFlight(now: number) {
		const f = this.flight!;
		const p = f.duration ? clamp((now - f.start) / f.duration, 0, 1) : 1;
		const a = direction(f.from.lat, f.from.lon);
		const b = direction(f.to.lat, f.to.lon);
		const angle = a.angleTo(b);
		const t = f.cinematic ? ease(clamp((p - 0.1) / 0.7, 0, 1)) : ease(p);
		// Great-circle interpolation between where we are and where we are going.
		const dir =
			angle < 1e-5
				? b
				: a.multiplyScalar(Math.sin((1 - t) * angle) / Math.sin(angle)).add(b.multiplyScalar(Math.sin(t * angle) / Math.sin(angle)));
		this.view.lat = Math.asin(clamp(dir.y, -1, 1)) / RAD;
		this.view.lon = Math.atan2(dir.x, dir.z) / RAD;

		// Altitude is eased on a log scale, so the approach slows gracefully the closer it gets.
		const from = Math.log(f.from.alt);
		const to = Math.log(f.to.alt);
		let alt: number;
		if (f.cinematic) {
			const high = Math.log(Math.max(CRUISE_ALTITUDE, f.from.alt));
			alt = p < 0.34 ? from + (high - from) * ease(p / 0.34) : p < 0.5 ? high : high + (to - high) * ease((p - 0.5) / 0.5);
			this.glowTarget = smooth(0.8, 0.97, p);
		} else {
			alt = from + (to - from) * ease(p);
		}
		this.view.alt = Math.exp(alt);

		if (p >= 1) {
			this.flight = null;
			this.velocity = { lat: 0, lon: 0 };
			f.done();
		}
	}

	private fly(to: View, duration: number, cinematic: boolean) {
		return new Promise<void>((resolve) => {
			this.flight?.done();
			this.flight = {
				from: { ...this.view },
				to,
				start: performance.now(),
				duration: this.options.reducedMotion ? 0 : duration,
				cinematic,
				done: resolve,
			};
		});
	}

	/**
	 * Travels to a name and lights it. `cinematic` is the full journey: pull
	 * back from the Earth, cross the field of stars, descend to the name.
	 * Otherwise a short, direct glide (used when a name is tapped nearby).
	 */
	async flyToSlot(slot: number, label: string, cinematic: boolean) {
		const rect = slotRect(slot, this.level);
		this.focusSlot = slot;
		this.focusLabel = label;
		this.hoverMesh.visible = false;
		this.paintGlow();
		this.glowTarget = cinematic && !this.options.reducedMotion ? 0 : 1;
		const to = {
			lat: rect.lat0 + rect.dLat / 2,
			lon: rect.lon0 + rect.dLon / 2,
			alt: this.altitudeFor(this.camera.aspect < 1 ? 0.62 : 0.3),
		};
		await this.fly(to, cinematic ? 7500 : 1400, cinematic);
		if (this.focusSlot === slot) this.glowTarget = 1;
	}

	/** Jumps to the end of the journey in progress. */
	skip() {
		if (this.flight) this.flight.duration = 0;
	}

	clearFocus() {
		this.focusSlot = -1;
		this.glowTarget = 0;
	}

	home() {
		this.clearFocus();
		return this.fly({ lat: 18, lon: this.view.lon, alt: this.homeAltitude() }, 1800, false);
	}

	// ----------------------------------------------------------------- input

	/** The slot under a screen position, or -1 if it misses the Earth or lands on an open place. */
	private slotUnder(clientX: number, clientY: number) {
		const bounds = this.renderer.domElement.getBoundingClientRect();
		const ndc = new THREE.Vector3(((clientX - bounds.left) / bounds.width) * 2 - 1, -((clientY - bounds.top) / bounds.height) * 2 + 1, 0.5);
		const origin = this.camera.position;
		const ray = ndc.unproject(this.camera).sub(origin).normalize();
		const b = origin.dot(ray);
		const disc = b * b - (origin.lengthSq() - 1);
		if (disc < 0) return -1;
		const hit = origin.clone().addScaledVector(ray, -b - Math.sqrt(disc));
		const slot = slotAtPoint(Math.asin(clamp(hit.y, -1, 1)) / RAD, Math.atan2(hit.x, hit.z) / RAD, this.level);
		return this.filled(slot) ? slot : -1;
	}

	/** Names are selectable once they are large enough on screen to read. */
	private namesReadable() {
		const pixels = (((ROW_H / 2 ** this.level) * RAD) / (2 * this.view.alt * TAN_HALF)) * this.container.clientHeight;
		return pixels >= 9;
	}

	private listen() {
		const el = this.renderer.domElement;
		el.addEventListener("pointerdown", this.onDown);
		el.addEventListener("pointermove", this.onMove);
		el.addEventListener("pointerup", this.onUp);
		el.addEventListener("pointercancel", this.onUp);
		el.addEventListener("pointerleave", this.onLeave);
		el.addEventListener("wheel", this.onWheel, { passive: false });
	}

	/** Stops a short glide when the visitor takes over. The full journey can only be skipped, not interrupted. */
	private interrupt() {
		if (this.flight?.cinematic) return false;
		const flight = this.flight;
		this.flight = null;
		flight?.done();
		return true;
	}

	/** Zoom controls for people who can't scroll or pinch. */
	zoomBy(factor: number) {
		this.lastTouch = performance.now();
		this.zoom(factor);
	}

	private zoom(factor: number) {
		if (!this.interrupt()) return;
		this.view.alt = clamp(this.view.alt * factor, this.altitudeFor(0.9), this.homeAltitude() * 1.5);
	}

	private onDown = (e: PointerEvent) => {
		this.lastTouch = performance.now();
		this.renderer.domElement.setPointerCapture(e.pointerId);
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (this.pointers.size === 1) this.press = { x: e.clientX, y: e.clientY, time: performance.now(), moved: false };
		else {
			this.press = null;
			const [a, b] = [...this.pointers.values()];
			this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
		}
	};

	private onMove = (e: PointerEvent) => {
		const previous = this.pointers.get(e.pointerId);
		if (!previous) {
			if (e.pointerType === "mouse") this.hover(e.clientX, e.clientY);
			return;
		}
		this.lastTouch = performance.now();
		const dx = e.clientX - previous.x;
		const dy = e.clientY - previous.y;
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

		if (this.pointers.size >= 2) {
			const [a, b] = [...this.pointers.values()];
			const spread = Math.hypot(a.x - b.x, a.y - b.y);
			if (this.pinch > 0 && spread > 0) this.zoom(this.pinch / spread);
			this.pinch = spread;
			return;
		}
		if (this.press && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > 6) this.press.moved = true;
		if (!this.press?.moved || !this.interrupt()) return;
		// Degrees per pixel, so the point under the finger stays under the finger at any zoom.
		const k = Math.min(0.28, ((2 * this.view.alt * TAN_HALF) / this.container.clientHeight) / RAD);
		const dLon = (-dx * k) / Math.max(0.2, Math.cos(this.view.lat * RAD));
		const dLat = dy * k;
		this.view.lon += dLon;
		this.view.lat = clamp(this.view.lat + dLat, -85, 85);
		this.velocity = { lat: dLat * 60 * 0.6, lon: dLon * 60 * 0.6 };
	};

	private onUp = (e: PointerEvent) => {
		this.pointers.delete(e.pointerId);
		this.pinch = 0;
		const press = this.press;
		this.press = null;
		if (!press || press.moved || performance.now() - press.time > 600 || this.flight) return;
		this.velocity = { lat: 0, lon: 0 };
		if (!this.namesReadable()) return;
		const slot = this.slotUnder(e.clientX, e.clientY);
		if (slot >= 0) this.options.onPick(slot, slot >= this.realSlots);
	};

	private onLeave = () => {
		this.hoverSlot = -1;
		this.hoverMesh.visible = false;
		this.renderer.domElement.style.cursor = "";
	};

	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
		this.lastTouch = performance.now();
		this.zoom(Math.exp(clamp(e.deltaY, -240, 240) * 0.0016));
	};

	private hover(x: number, y: number) {
		const slot = this.flight || !this.namesReadable() ? -1 : this.slotUnder(x, y);
		if (slot === this.hoverSlot) return;
		this.hoverSlot = slot;
		const show = slot >= 0 && slot !== this.focusSlot;
		this.renderer.domElement.style.cursor = slot >= 0 ? "pointer" : "";
		this.hoverMesh.visible = show;
		if (show) {
			this.hoverMesh.geometry.dispose();
			this.hoverMesh.geometry = patchGeometry(this.rectSpan(slotRect(slot, this.level)), 1.0005, 6);
		}
	}

	dispose() {
		this.disposed = true;
		cancelAnimationFrame(this.raf);
		this.observer.disconnect();
		this.flight?.done();
		this.renderer.dispose();
		this.renderer.domElement.remove();
	}
}
