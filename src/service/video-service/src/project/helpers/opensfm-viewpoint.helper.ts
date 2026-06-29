/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
export type Vec3 = [number, number, number];

export type OpenSfMShot = {
  camera?: string;
  rotation?: number[];
  translation?: number[];
  capture_time?: number;
};

export type OpenSfMReconstruction = {
  cameras?: Record<string, unknown>;
  shots?: Record<string, OpenSfMShot>;
  points?: Record<string, unknown>;
};

export type PlyViewpoint = {
  frameName: string;
  position: Vec3;
  target: Vec3;
  up: Vec3;
  rotation: Vec3;
  translation: Vec3;
};

export function normalizeFrameName(value?: string | null) {
  if (!value) return '';

  return value.replace(/\\/g, '/').split('/').pop()?.toLowerCase().trim() ?? '';
}

function toVec3(value?: number[]): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;

  const vec = value.slice(0, 3).map((item) => Number(item));

  if (vec.some((item) => !Number.isFinite(item))) return null;

  return [vec[0], vec[1], vec[2]];
}

function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vecScale(a: Vec3, scale: number): Vec3 {
  return [a[0] * scale, a[1] * scale, a[2] * scale];
}

function vecNorm(a: Vec3) {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

function vecNormalize(a: Vec3): Vec3 {
  const norm = vecNorm(a);

  if (norm < 1e-12) {
    return [0, 1, 0];
  }

  return [a[0] / norm, a[1] / norm, a[2] / norm];
}

function matVecMul(matrix: number[][], vector: Vec3): Vec3 {
  return [
    matrix[0][0] * vector[0] +
      matrix[0][1] * vector[1] +
      matrix[0][2] * vector[2],
    matrix[1][0] * vector[0] +
      matrix[1][1] * vector[1] +
      matrix[1][2] * vector[2],
    matrix[2][0] * vector[0] +
      matrix[2][1] * vector[1] +
      matrix[2][2] * vector[2],
  ];
}

function transpose(matrix: number[][]) {
  return [
    [matrix[0][0], matrix[1][0], matrix[2][0]],
    [matrix[0][1], matrix[1][1], matrix[2][1]],
    [matrix[0][2], matrix[1][2], matrix[2][2]],
  ];
}

function rodrigues(rotation: Vec3) {
  const theta = vecNorm(rotation);

  if (theta < 1e-12) {
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  }

  const kx = rotation[0] / theta;
  const ky = rotation[1] / theta;
  const kz = rotation[2] / theta;

  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const oneMinusCos = 1 - cos;

  return [
    [
      cos + kx * kx * oneMinusCos,
      kx * ky * oneMinusCos - kz * sin,
      kx * kz * oneMinusCos + ky * sin,
    ],
    [
      ky * kx * oneMinusCos + kz * sin,
      cos + ky * ky * oneMinusCos,
      ky * kz * oneMinusCos - kx * sin,
    ],
    [
      kz * kx * oneMinusCos - ky * sin,
      kz * ky * oneMinusCos + kx * sin,
      cos + kz * kz * oneMinusCos,
    ],
  ];
}

function roundVec3(vec: Vec3): Vec3 {
  return [
    Number(vec[0].toFixed(6)),
    Number(vec[1].toFixed(6)),
    Number(vec[2].toFixed(6)),
  ];
}

export function normalizeOpenSfMReconstruction(
  value: unknown,
): OpenSfMReconstruction | null {
  if (!value) return null;

  if (Array.isArray(value)) {
    return (value[0] ?? null) as OpenSfMReconstruction | null;
  }

  return value as OpenSfMReconstruction;
}

export function shotToViewpoint(
  frameName: string,
  shot: OpenSfMShot,
): PlyViewpoint | null {
  const rotation = toVec3(shot.rotation);
  const translation = toVec3(shot.translation);

  if (!rotation || !translation) return null;

  const rotationMatrix = rodrigues(rotation);
  const rotationMatrixT = transpose(rotationMatrix);

  const cameraCenter = vecScale(matVecMul(rotationMatrixT, translation), -1);

  const forward = vecNormalize(matVecMul(rotationMatrixT, [0, 0, 1]));
  const up = vecNormalize(matVecMul(rotationMatrixT, [0, -1, 0]));
  const target = vecAdd(cameraCenter, forward);

  return {
    frameName,
    position: roundVec3(cameraCenter),
    target: roundVec3(target),
    up: roundVec3(up),
    rotation: roundVec3(rotation),
    translation: roundVec3(translation),
  };
}

export function buildShotViewpointMap(reconstructionValue: unknown) {
  const reconstruction = normalizeOpenSfMReconstruction(reconstructionValue);
  const shots = reconstruction?.shots ?? {};

  const map = new Map<string, PlyViewpoint>();

  for (const [shotName, shot] of Object.entries(shots)) {
    const viewpoint = shotToViewpoint(shotName, shot);

    if (viewpoint) {
      map.set(normalizeFrameName(shotName), viewpoint);
    }
  }

  return map;
}
