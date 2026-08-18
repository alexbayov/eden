import type {
  BodyPart,
  CoverType,
  Posture,
  Statuses,
  Unit,
  WeaponState,
  ArmorState,
} from "./combat";
import { enemyById, weaponById, type EquipmentCatalog } from "./equipment-content";
import {
  CONTENT_VERSION,
  ContentValidationError,
  checkEnvelope,
  fetchContent,
  isInt,
  isNonEmptyString,
  isRecord,
  type ContentIssue,
  type ContentResult,
} from "./content-format";
export {
  CONTENT_VERSION,
  ContentLoadError,
  ContentValidationError,
  migrateContent,
  type ContentIssue,
  type ContentResult,
} from "./content-format";
export type CoverKind = Exclude<CoverType, "none">;
export interface ContentCover {
  x: number;
  y: number;
  type: CoverKind;
}
export type ContentUnit = Omit<Unit, "ap">;
export interface ArenaContent {
  contentVersion: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  tile: { width: number; height: number };
  units: ContentUnit[];
  cover: ContentCover[];
}
export type ArenaConfig = ArenaContent;
export type Cover = ContentCover;
const parts = new Set<BodyPart>([
  "head",
  "torso",
  "arm",
  "leg",
  "eye",
  "groin",
]);
const postures = new Set<Posture>(["stand", "crouch", "prone"]);
const statuses = new Set<keyof Statuses>([
  "arm",
  "leg",
  "immobilized",
  "blind",
  "shocked",
  "head",
]);
const finite = (
  v: unknown,
  p: string,
  issues: ContentIssue[],
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): v is number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    issues.push({ path: p, message: `конечное число ${min}..${max}` });
    return false;
  }
  return true;
};
const requiredString = (v: unknown, p: string, issues: ContentIssue[]) => {
  if (!isNonEmptyString(v))
    issues.push({ path: p, message: "непустая строка" });
};
function checkWeapon(value: unknown, path: string, issues: ContentIssue[]) {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект состояния оружия" });
    return;
  }
  const before = issues.length;
  for (const k of ["weaponInstanceId", "weaponId", "name", "ammoId"] as const)
    requiredString(value[k], `${path}.${k}`, issues);
  for (const k of [
    "magazine",
    "magazineSize",
    "reserveAmmo",
    "durability",
    "maxDurability",
    "durabilityPerShot",
    "reloadAp",
  ] as const) {
    finite(value[k], `${path}.${k}`, issues);
    if (!isInt(value[k]))
      issues.push({ path: `${path}.${k}`, message: "целое число" });
  }
  for (const k of ["baseDamage", "accuracyModifier", "critModifier"] as const)
    finite(value[k], `${path}.${k}`, issues, -100, 1000);
  finite(value.penetration, `${path}.penetration`, issues, 0, 1);
  finite(
    value.ammoDamageModifier,
    `${path}.ammoDamageModifier`,
    issues,
    -1,
    10,
  );
  finite(
    value.ammoPenetrationModifier,
    `${path}.ammoPenetrationModifier`,
    issues,
    -1,
    1,
  );
  if (typeof value.makeshift !== "boolean")
    issues.push({ path: `${path}.makeshift`, message: "boolean" });
  if (
    value.malfunctioned !== undefined &&
    typeof value.malfunctioned !== "boolean"
  )
    issues.push({ path: `${path}.malfunctioned`, message: "boolean" });
  const magazine = value.magazine,
    size = value.magazineSize,
    durability = value.durability,
    maxDurability = value.maxDurability;
  if (
    isInt(magazine) &&
    isInt(size) &&
    (magazine < 0 || magazine > size || size < 1)
  )
    issues.push({ path, message: "корректный магазин" });
  if (
    isInt(durability) &&
    isInt(maxDurability) &&
    (durability < 0 || durability > maxDurability || maxDurability < 1)
  )
    issues.push({ path, message: "корректная durability" });
  return issues.length === before
    ? (value as unknown as WeaponState)
    : undefined;
}
function checkArmor(value: unknown, path: string, issues: ContentIssue[]) {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект брони" });
    return;
  }
  const before = issues.length;
  requiredString(value.armorInstanceId, `${path}.armorInstanceId`, issues);
  requiredString(value.armorId, `${path}.armorId`, issues);
  if (!isRecord(value.reduction))
    issues.push({ path: `${path}.reduction`, message: "объект защиты" });
  else
    for (const [part, reduction] of Object.entries(value.reduction)) {
      if (!parts.has(part as BodyPart))
        issues.push({
          path: `${path}.reduction.${part}`,
          message: "известная часть тела",
        });
      else finite(reduction, `${path}.reduction.${part}`, issues, 0, 1000);
    }
  for (const k of ["durability", "maxDurability"] as const) {
    finite(value[k], `${path}.${k}`, issues);
    if (!isInt(value[k]))
      issues.push({ path: `${path}.${k}`, message: "целое число" });
  }
  const durability = value.durability,
    maxDurability = value.maxDurability;
  if (
    isInt(durability) &&
    isInt(maxDurability) &&
    (durability < 0 || durability > maxDurability || maxDurability < 1)
  )
    issues.push({ path, message: "корректная durability" });
  return issues.length === before
    ? (value as unknown as ArmorState)
    : undefined;
}
function checkUnit(
  value: unknown,
  path: string,
  issues: ContentIssue[],
): ContentUnit | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "ожидался объект юнита" });
    return null;
  }
  const before = issues.length;
  requiredString(value.id, `${path}.id`, issues);
  requiredString(value.name, `${path}.name`, issues);
  if (value.team !== "player" && value.team !== "enemy")
    issues.push({ path: `${path}.team`, message: "player | enemy" });
  for (const k of ["x", "y", "hp", "maxHp", "aim"] as const)
    if (!isInt(value[k]))
      issues.push({ path: `${path}.${k}`, message: "целое число" });
  const x = value.x,
    y = value.y,
    hp = value.hp,
    maxHp = value.maxHp;
  if (isInt(x) && x < 0) issues.push({ path: `${path}.x`, message: ">= 0" });
  if (isInt(y) && y < 0) issues.push({ path: `${path}.y`, message: ">= 0" });
  if (isInt(hp) && isInt(maxHp) && (hp < 0 || maxHp < 1 || hp > maxHp))
    issues.push({ path, message: "корректное HP" });
  if (typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color))
    issues.push({ path: `${path}.color`, message: "hex вида #rrggbb" });
  if (
    value.posture !== undefined &&
    (!isNonEmptyString(value.posture) ||
      !postures.has(value.posture as Posture))
  )
    issues.push({ path: `${path}.posture`, message: "valid posture" });
  if (value.statuses !== undefined) {
    if (!isRecord(value.statuses))
      issues.push({ path: `${path}.statuses`, message: "объект статусов" });
    else
      for (const [k, turns] of Object.entries(value.statuses))
        if (!statuses.has(k as keyof Statuses) || !isInt(turns) || turns < 0)
          issues.push({
            path: `${path}.statuses.${k}`,
            message: "известный неотрицательный статус",
          });
  }
  if (value.weapon !== undefined || value.armorByPart !== undefined)
    issues.push({ path, message: "legacy equipment fields are not supported" });
  if (value.weaponState !== undefined)
    checkWeapon(value.weaponState, `${path}.weaponState`, issues);
  if (value.armor !== undefined)
    checkArmor(value.armor, `${path}.armor`, issues);
  return issues.length === before ? (value as unknown as ContentUnit) : null;
}
function checkCover(
  value: unknown,
  path: string,
  width: number,
  height: number,
  issues: ContentIssue[],
): ContentCover | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "ожидался объект укрытия" });
    return null;
  }
  const before = issues.length;
  const x = value.x,
    y = value.y;
  if (!isInt(x) || x < 0 || x >= width)
    issues.push({ path: `${path}.x`, message: `целое 0..${width - 1}` });
  if (!isInt(y) || y < 0 || y >= height)
    issues.push({ path: `${path}.y`, message: `целое 0..${height - 1}` });
  if (value.type !== "partial" && value.type !== "full")
    issues.push({ path: `${path}.type`, message: "partial | full" });
  return issues.length === before ? (value as unknown as ContentCover) : null;
}
function validateEquipmentReferences(
  arenas: readonly ArenaConfig[],
  equipment: EquipmentCatalog,
): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const weaponIds = new Set(equipment.weapons.map((weapon) => weapon.id));
  const ammoIds = new Set(equipment.ammo.map((ammo) => ammo.id));
  const armorIds = new Set(equipment.armor.map((armor) => armor.id));
  const enemyIds = new Set(equipment.enemies.map((enemy) => enemy.id));
  const checkWeapon = (weaponId: unknown, ammoId: unknown, path: string) => {
    if (!isNonEmptyString(weaponId) || !weaponIds.has(weaponId))
      issues.push({ path: `${path}.weaponId`, message: "ссылка на существующее weapon" });
    const weapon = isNonEmptyString(weaponId) ? weaponById(equipment, weaponId) : null;
    const expectedAmmo = weapon?.ammoId ?? ammoId;
    if (!isNonEmptyString(expectedAmmo) || !ammoIds.has(expectedAmmo))
      issues.push({ path: `${path}.ammoId`, message: "ссылка на существующий ammo" });
    if (weapon && isNonEmptyString(ammoId) && weapon.ammoId !== ammoId)
      issues.push({ path: `${path}.ammoId`, message: "ammo соответствует weapon definition" });
  };
  const checkArmor = (armorId: unknown, path: string) => {
    if (!isNonEmptyString(armorId)) {
      issues.push({ path, message: "ссылка на существующий armor" });
      return;
    }
    const parts = armorId.split("+");
    for (const part of parts)
      if (!armorIds.has(part)) issues.push({ path, message: "ссылка на существующий armor" });
  };
  for (const arena of arenas) {
    for (const [index, unit] of arena.units.entries()) {
      const path = `arenas.${arena.id}.units[${index}]`;
      if (unit.team === "enemy" && unit.archetypeId !== undefined) {
        if (!isNonEmptyString(unit.archetypeId) || !enemyIds.has(unit.archetypeId)) {
          issues.push({ path: `${path}.archetypeId`, message: "ссылка на существующий enemy archetype" });
        } else {
          const archetype = enemyById(equipment, unit.archetypeId);
          if (archetype) {
            checkWeapon(archetype.weaponId, weaponById(equipment, archetype.weaponId)?.ammoId, `${path}.archetypeId.weapon`);
            archetype.armorIds.forEach((armorId, armorIndex) => checkArmor(armorId, `${path}.archetypeId.armorIds[${armorIndex}]`));
          }
        }
      }
      if (unit.weaponState)
        checkWeapon(unit.weaponState.weaponId, unit.weaponState.ammoId, `${path}.weaponState`);
      if (unit.armor) checkArmor(unit.armor.armorId, `${path}.armor.armorId`);
    }
  }
  return issues;
}

export function validateArenaWithEquipment(
  arena: ArenaConfig,
  equipment: EquipmentCatalog,
): ArenaConfig {
  const issues = validateEquipmentReferences([arena], equipment);
  if (issues.length) throw new ContentValidationError("shape", issues);
  return arena;
}

export function validateArenaContent(
  input: unknown,
): ContentResult<ArenaContent> {
  const envelope = checkEnvelope(input);
  if (!envelope.ok) return envelope;
  const value = envelope.value,
    issues: ContentIssue[] = [];
  requiredString(value.id, "$.id", issues);
  requiredString(value.name, "$.name", issues);
  for (const k of ["width", "height"] as const)
    if (!isInt(value[k]) || value[k] < 1)
      issues.push({ path: `$.${k}`, message: "целое >= 1" });
  if (
    !isRecord(value.tile) ||
    !isInt(value.tile.width) ||
    !isInt(value.tile.height) ||
    value.tile.width < 1 ||
    value.tile.height < 1
  )
    issues.push({ path: "$.tile", message: "положительные целые" });
  const width = value.width,
    height = value.height,
    tile = value.tile;
  const units: ContentUnit[] = [],
    cover: ContentCover[] = [];
  if (!Array.isArray(value.units) || !value.units.length)
    issues.push({ path: "$.units", message: "непустой массив" });
  else
    value.units.forEach((u, i) => {
      const checked = checkUnit(u, `$.units[${i}]`, issues);
      if (checked) units.push(checked);
    });
  if (!Array.isArray(value.cover))
    issues.push({ path: "$.cover", message: "массив" });
  else
    value.cover.forEach((c, i) => {
      const checked = checkCover(
        c,
        `$.cover[${i}]`,
        isInt(width) ? width : 0,
        isInt(height) ? height : 0,
        issues,
      );
      if (checked) cover.push(checked);
    });
  if (units.filter((u) => u.id === "hero" && u.team === "player").length !== 1)
    issues.push({ path: "$.units", message: "ровно один player hero" });
  if (isInt(width) && isInt(height))
    for (const u of units)
      if (u.x >= width || u.y >= height)
        issues.push({ path: `$.units[${u.id}]`, message: "позиция вне сетки" });
  if (new Set(units.map((u) => u.id)).size !== units.length)
    issues.push({ path: "$.units", message: "дублирующийся id" });
  return issues.length
    ? { ok: false, error: new ContentValidationError("shape", issues) }
    : {
        ok: true,
        value: {
          contentVersion: CONTENT_VERSION,
          id: value.id as string,
          name: value.name as string,
          width: width as number,
          height: height as number,
          tile: tile as { width: number; height: number },
          units,
          cover,
        },
      };
}
export function parseArenaContent(value: unknown): ArenaContent {
  const result = validateArenaContent(value);
  if (!result.ok) throw result.error;
  return result.value;
}
export const loadArenaContent = (url = "/config/arena.json") =>
  fetchContent(url).then(parseArenaContent);
export const loadArena = loadArenaContent;

export interface ArenaManifestEntry {
  id: string;
  path: string;
}

export interface ArenaManifest {
  catalogId: string;
  entries: ArenaManifestEntry[];
}

export interface ArenaCatalog {
  catalogId: string;
  manifest: ArenaManifest;
  byId: ReadonlyMap<string, ArenaConfig>;
  all: ArenaConfig[];
}

export function validateArenaManifest(input: unknown): ContentResult<ArenaManifest> {
  const envelope = checkEnvelope(input);
  if (!envelope.ok) return envelope;
  const value = envelope.value;
  const issues: ContentIssue[] = [];
  requiredString(value.catalogId, "$.catalogId", issues);
  if (value.kind !== "arena-manifest")
    issues.push({ path: "$.kind", message: 'ожидалось "arena-manifest"' });
  const entries: ArenaManifestEntry[] = [];
  if (!Array.isArray(value.entries) || !value.entries.length)
    issues.push({ path: "$.entries", message: "непустой массив" });
  else
    value.entries.forEach((entry, index) => {
      if (!isRecord(entry) || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.path))
        issues.push({ path: `$.entries[${index}]`, message: "id и path — непустые строки" });
      else entries.push({ id: entry.id, path: entry.path });
    });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    issues.push({ path: "$.entries", message: "уникальные id карт" });
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    issues.push({ path: "$.entries", message: "уникальные пути карт" });
  return issues.length
    ? { ok: false, error: new ContentValidationError("shape", issues) }
    : { ok: true, value: { catalogId: value.catalogId as string, entries } };
}

export function parseArenaManifest(input: unknown): ArenaManifest {
  const result = validateArenaManifest(input);
  if (!result.ok) throw result.error;
  return result.value;
}

export const loadArenaManifest = (url = "/config/arena-manifest.json") =>
  fetchContent(url).then(parseArenaManifest);

export function validateArenaCatalog(
  manifestOrArenas: ArenaManifest | readonly ArenaConfig[],
  arenasOrExpectedIds?: readonly ArenaConfig[] | ReadonlySet<string>,
  expectedIds?: ReadonlySet<string>,
): ArenaCatalog {
  const manifest = (Array.isArray(manifestOrArenas)
    ? { catalogId: "legacy", entries: manifestOrArenas.map((arena) => ({ id: arena.id, path: arena.id })) }
    : manifestOrArenas) as ArenaManifest;
  const arenas: readonly ArenaConfig[] = Array.isArray(manifestOrArenas)
    ? manifestOrArenas
    : arenasOrExpectedIds as readonly ArenaConfig[];
  const expected = Array.isArray(manifestOrArenas) ? arenasOrExpectedIds as ReadonlySet<string> | undefined : expectedIds;
  const byId = new Map<string, ArenaConfig>();
  for (const arena of arenas) {
    if (byId.has(arena.id)) throw new ContentValidationError("shape", [{ path: `arenas.${arena.id}`, message: "дублирующийся id карты" }]);
    byId.set(arena.id, arena);
  }
  const manifestIds = new Set(manifest.entries.map((entry) => entry.id));
  if (manifestIds.size !== byId.size || [...manifestIds].some((id) => !byId.has(id)))
    throw new ContentValidationError("shape", [{ path: "arenas", message: "загруженные карты не соответствуют manifest" }]);
  if (expected && (expected.size !== byId.size || [...expected].some((id) => !byId.has(id))))
    throw new ContentValidationError("shape", [{ path: "arenas", message: "каталог карт не покрывает encounter arenaId" }]);
  return { catalogId: manifest.catalogId, manifest, byId, all: [...byId.values()] };
}

export async function loadArenaCatalog(
  manifest: ArenaManifest,
  expectedIds: ReadonlySet<string>,
  equipment?: EquipmentCatalog,
): Promise<ArenaCatalog> {
  const arenas = await Promise.all(manifest.entries.map(async (entry) => {
    const arena = await loadArenaContent(entry.path);
    if (arena.id !== entry.id)
      throw new ContentValidationError("shape", [{ path: `$.entries.${entry.id}`, message: "id manifest и карты не совпадают" }]);
    if (equipment) {
      const issues = validateEquipmentReferences([arena], equipment);
      if (issues.length) throw new ContentValidationError("shape", issues);
    }
    return arena;
  }));
  return validateArenaCatalog(manifest, arenas, expectedIds);
}
