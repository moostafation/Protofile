// Part builders ("symbols"): spec + catalog data -> placed components with ports and shapes.

import { catalog } from "./catalog";
import { Comp, port } from "./model";
import { Shape, cyl, ell, fru, obox } from "./shapes";
import { PipingSpec, specApi } from "./spec";
import { V3, addScaled, anyPerp, cross, dist, dot, lerp, norm, sub } from "./vec";

type Base = Pick<Comp, "tag" | "owner">;

export function makePipe(spec: PipingSpec, nps: string, b: Base, a: V3, z: V3, extra: Record<string, any> = {}): Comp {
  const { data, description } = specApi.pipe(spec, nps);
  const u = norm(sub(z, a));
  const length = dist(a, z);
  return {
    ...b,
    uid: `${b.owner.id}/${b.tag}`,
    kind: "PIPE",
    nps,
    ports: [port("P1", a, [-u[0], -u[1], -u[2]], "BW", nps), port("P2", z, u, "BW", nps)],
    shapes: [cyl(a, z, data.od / 2)],
    desc: description,
    skey: "",
    props: { length, schedule: data.schedule, od: data.od, wall: data.wall, weight: (data.weightPerM * length) / 1000, ...extra },
  };
}

export function makeElbow(
  spec: PipingSpec,
  nps: string,
  b: Base,
  vertex: V3,
  dIn: V3,
  dOut: V3,
  angleDeg: number,
  tangent: number,
  variant: string,
): Comp {
  const od = catalog.od(nps);
  const theta = (angleDeg * Math.PI) / 180;
  const start = addScaled(vertex, dIn, -tangent);
  const end = addScaled(vertex, dOut, tangent);
  const radius = tangent / Math.tan(theta / 2);
  const inward = norm(addScaled(dOut, dIn, -dot(dIn, dOut)));
  const center = addScaled(start, inward, radius);
  const normal = norm(cross(norm(sub(start, center)), dIn));
  const key = variant === "45 LR" ? "elbow45" : "elbow90";
  let desc = specApi.bw(spec, key, nps);
  if (variant.startsWith("90 LR trimmed")) desc = desc.replace("ELBOW 90 LR", `ELBOW 90 LR TRIMMED TO ${+angleDeg.toFixed(2)} DEG`);
  return {
    ...b,
    uid: `${b.owner.id}/${b.tag}`,
    kind: "ELBOW",
    nps,
    ports: [port("P1", start, [-dIn[0], -dIn[1], -dIn[2]], "BW", nps), port("P2", end, dOut, "BW", nps)],
    shapes: [{ t: "tor", c: center, s: start, n: normal, ang: theta, r: od / 2 }],
    desc,
    skey: specApi.part(spec, key).skey,
    props: { angle: angleDeg, variant, bendRadius: radius, centerToEnd: tangent, vertex, schedule: specApi.schedule(spec, nps) },
  };
}

export function makeTee(spec: PipingSpec, nps: string, b: Base, center: V3, d: V3, branch: V3): Comp {
  const od = catalog.od(nps);
  const c = catalog.tee(nps);
  const p1 = addScaled(center, d, -c);
  const p2 = addScaled(center, d, c);
  const br = addScaled(center, branch, c);
  return {
    ...b,
    uid: `${b.owner.id}/${b.tag}`,
    kind: "TEE",
    nps,
    ports: [port("P1", p1, [-d[0], -d[1], -d[2]], "BW", nps), port("P2", p2, d, "BW", nps), port("BR", br, branch, "BW", nps)],
    shapes: [cyl(p1, p2, od / 2), cyl(center, br, od / 2)],
    desc: specApi.bw(spec, "tee", nps),
    skey: specApi.part(spec, "tee").skey,
    props: { center, centerToEnd: c, branchDir: branch, schedule: specApi.schedule(spec, nps) },
  };
}

/** Weld-neck flange from its weld end to its raised-face contact surface. */
export function makeFlange(spec: PipingSpec, nps: string, b: Base, weld: V3, face: V3): Comp {
  const fl = specApi.flange(spec, nps);
  const od = catalog.od(nps);
  const u = norm(sub(face, weld));
  const back = addScaled(face, u, -(fl.tf + fl.rfHeight));
  const rfStart = addScaled(face, u, -fl.rfHeight);
  return {
    ...b,
    uid: `${b.owner.id}/${b.tag}`,
    kind: "FLANGE",
    nps,
    ports: [port("WELD", weld, [-u[0], -u[1], -u[2]], "BW", nps), port("FACE", face, u, "FL", nps)],
    shapes: [fru(weld, back, od / 2, fl.hubDia / 2), cyl(back, rfStart, fl.o / 2), cyl(rfStart, face, fl.rfDia / 2)],
    desc: `${specApi.part(spec, "flange").description}, SCH ${specApi.schedule(spec, nps)} BORE`,
    skey: specApi.part(spec, "flange").skey,
    props: { rating: spec.rating, length: fl.length, bolts: fl.bolts, boltDia: fl.boltDia },
  };
}

export function makeGasket(spec: PipingSpec, nps: string, b: Base, a: V3, z: V3): Comp {
  const fl = specApi.flange(spec, nps);
  const u = norm(sub(z, a));
  return {
    ...b,
    uid: `${b.owner.id}/${b.tag}`,
    kind: "GASKET",
    nps,
    ports: [port("P1", a, [-u[0], -u[1], -u[2]], "FL", nps), port("P2", z, u, "FL", nps)],
    shapes: [cyl(a, z, (fl.bc - fl.boltDiaMm) / 2)],
    desc: specApi.part(spec, "gasket").description,
    props: { thickness: dist(a, z), rating: spec.rating, bolts: fl.bolts, boltDia: fl.boltDia },
    skey: "",
  };
}

/** Flanged valve between its two flange faces, with body and operator. */
export function makeValve(spec: PipingSpec, nps: string, b: Base, type: string, a: V3, z: V3, stem: V3): Comp {
  const { length, rule } = specApi.valve(spec, type, nps);
  const fl = specApi.flange(spec, nps);
  const od = catalog.od(nps);
  const u = norm(sub(z, a));
  const c = lerp(a, z, 0.5);
  const o = fl.o;
  const t = Math.min(fl.tf, length / 5);
  const side = norm(cross(stem, u));
  const shapes: Shape[] = [cyl(a, addScaled(a, u, t), o / 2), cyl(addScaled(z, u, -t), z, o / 2)];
  const bodyR = Math.max(od * 0.75, o * 0.36);
  if (type === "check") {
    shapes.push(fru(addScaled(a, u, t), c, od * 0.62, bodyR), fru(c, addScaled(z, u, -t), bodyR, od * 0.62));
    shapes.push(ell(addScaled(c, stem, bodyR * 0.55), [u, side, stem], [length * 0.32, bodyR * 0.8, bodyR * 0.75]));
    shapes.push(cyl(addScaled(c, stem, bodyR * 0.9), addScaled(c, stem, bodyR * 1.35), bodyR * 0.62));
  } else {
    const globe = type === "globe";
    shapes.push(fru(addScaled(a, u, t), c, od * 0.62, bodyR * (globe ? 1 : 0.8)));
    shapes.push(fru(c, addScaled(z, u, -t), bodyR * (globe ? 1 : 0.8), od * 0.62));
    shapes.push(ell(c, [u, side, stem], globe ? [length * 0.36, bodyR * 1.1, bodyR * 1.1] : [length * 0.2, bodyR * 0.9, bodyR * 1.15]));
    const bonnetTop = addScaled(c, stem, bodyR + o * 0.55);
    shapes.push(fru(addScaled(c, stem, bodyR * 0.6), bonnetTop, bodyR * 0.62, bodyR * 0.42));
    // yoke + stem + handwheel
    const yokeTop = addScaled(bonnetTop, stem, o * 0.65);
    shapes.push(obox(lerp(bonnetTop, yokeTop, 0.5), [side, u, stem], [bodyR * 0.9, o * 0.08, o * 0.65]));
    shapes.push(cyl(bonnetTop, addScaled(yokeTop, stem, o * 0.35), o * 0.035));
    const wheelR = Math.max(o * 0.55, 90);
    const hub = addScaled(yokeTop, stem, o * 0.08);
    shapes.push({ t: "tor", c: hub, s: addScaled(hub, anyPerp(stem), wheelR), n: stem, ang: Math.PI * 2, r: Math.max(o * 0.035, 8) });
    for (const k of [0, 1]) {
      const spoke = k ? side : u;
      shapes.push(cyl(addScaled(hub, spoke, -wheelR), addScaled(hub, spoke, wheelR), Math.max(o * 0.018, 5)));
    }
  }
  return {
    ...b,
    uid: `${b.owner.id}/${b.tag}`,
    kind: "VALVE",
    nps,
    ports: [port("P1", a, [-u[0], -u[1], -u[2]], "FL", nps), port("P2", z, u, "FL", nps)],
    shapes,
    desc: rule.description,
    skey: rule.skey,
    props: { valveType: type, faceToFace: length, rating: spec.rating, stem, center: c },
  };
}

/** Pipe shoe (T-shoe) under a horizontal pipe, standing on a beam top. */
export function makeShoe(nps: string, b: Base, at: V3, along: V3, height: number, desc: string): Comp {
  const od = catalog.od(nps);
  const bottom = addScaled(at, [0, 0, 1], -(od / 2 + height));
  const side = norm(cross([0, 0, 1], along));
  const len = Math.max(300, od * 1.2);
  const web = obox(addScaled(bottom, [0, 0, 1], height / 2 + od * 0.15), [along, side, [0, 0, 1]], [len, 12, height + od * 0.3]);
  const base = obox(addScaled(bottom, [0, 0, 1], 6), [along, side, [0, 0, 1]], [len, Math.max(od * 0.7, 100), 12]);
  return {
    ...b,
    uid: `${b.owner.id}/${b.tag}`,
    kind: "SUPPORT",
    nps,
    ports: [],
    shapes: [web, base],
    desc,
    skey: "",
    props: { height, at, bottom },
  };
}

