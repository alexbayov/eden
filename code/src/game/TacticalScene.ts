import Phaser from 'phaser'
import type { ArenaConfig, Cover } from './content'
import type { Point, Unit } from './combat'

interface SceneEvents { onCellClick: (x: number, y: number) => void; onUnitClick: (id: string) => void; onCellHover: (x: number, y: number) => void }
export interface SceneState { units: Unit[]; selectedId: string | null; targetId: string | null; reachable: Set<string>; targetable: Set<string>; hover: Point | null; path: Point[] }
const key = (x: number, y: number) => `${x},${y}`
const iso = (x: number, y: number, ox: number, oy: number, tw: number, th: number) => ({ x: ox + (x - y) * tw / 2, y: oy + (x + y) * th / 2 })

export class TacticalScene extends Phaser.Scene {
  private config!: ArenaConfig
  private callbacks!: SceneEvents
  private state: SceneState = { units: [], selectedId: null, targetId: null, reachable: new Set(), targetable: new Set(), hover: null, path: [] }
  constructor() { super('tactical') }
  init(data: { config: ArenaConfig; events: SceneEvents; state: SceneState }) { this.config = data.config; this.callbacks = data.events; this.state = data.state }
  create() { this.redraw() }
  updateState(state: SceneState) { this.state = state; this.redraw() }
  private redraw() {
    this.children.removeAll()
    if (!this.config) return
    const { width, height, tile } = this.config
    const ox = this.scale.width / 2; const oy = 106
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) this.drawTile(x, y, ox, oy, tile.width, tile.height)
    this.config.cover.forEach((cover) => this.drawCover(cover, ox, oy, tile.width, tile.height))
    this.drawPath(ox, oy, tile.width, tile.height)
    this.state.units.filter((unit) => unit.hp > 0).sort((a, b) => a.y - b.y || a.x - b.x).forEach((unit) => this.drawUnit(unit, ox, oy, tile.width, tile.height))
    this.add.text(14, 14, 'ЛЕГЕНДА: голубой — маршрут/доступно · жёлтый — выбран · красный — видимая цель · серый — полное укрытие · охра — частичное', { fontSize: '11px', color: '#c8d9dd', fontFamily: 'monospace', backgroundColor: '#071017aa', padding: { x: 6, y: 4 } })
  }
  private drawTile(x: number, y: number, ox: number, oy: number, tw: number, th: number) {
    const point = iso(x, y, ox, oy, tw, th); const cell = key(x, y); const hovered = this.state.hover?.x === x && this.state.hover?.y === y
    const color = this.state.targetable.has(cell) ? 0x713b43 : this.state.reachable.has(cell) ? 0x285d71 : hovered ? 0x4a6875 : (x + y) % 2 === 0 ? 0x1e3442 : 0x1a2d3a
    const polygon = new Phaser.Geom.Polygon([point.x, point.y - th / 2, point.x + tw / 2, point.y, point.x, point.y + th / 2, point.x - tw / 2, point.y])
    const tile = this.add.polygon(0, 0, polygon.points, color).setStrokeStyle(hovered ? 2 : 1, hovered ? 0xe6f7ff : 0x4b7183, hovered ? 1 : .58).setInteractive(polygon, Phaser.Geom.Polygon.Contains)
    tile.on('pointerdown', () => this.callbacks.onCellClick(x, y)); tile.on('pointerover', () => this.callbacks.onCellHover(x, y)); tile.on('pointerout', () => this.callbacks.onCellHover(-1, -1))
  }
  private drawPath(ox: number, oy: number, tw: number, th: number) {
    if (this.state.path.length < 2) return
    const graphics = this.add.graphics().lineStyle(3, 0x80e7f7, .95)
    const start = iso(this.state.path[0].x, this.state.path[0].y, ox, oy, tw, th); graphics.beginPath().moveTo(start.x, start.y)
    this.state.path.slice(1).forEach((cell) => { const point = iso(cell.x, cell.y, ox, oy, tw, th); graphics.lineTo(point.x, point.y) }); graphics.strokePath()
  }
  private drawCover(cover: Cover, ox: number, oy: number, tw: number, th: number) {
    const point = iso(cover.x, cover.y, ox, oy, tw, th); const height = cover.type === 'full' ? 38 : 23
    this.add.rectangle(point.x, point.y - height / 2, 35, height, cover.type === 'full' ? 0x5e7483 : 0xa8905b).setStrokeStyle(2, 0xd9d1ba)
    this.add.text(point.x, point.y - height - 8, cover.type === 'full' ? 'ПОЛНОЕ' : 'ЧАСТ.', { fontSize: '9px', color: '#dfe9e9', fontFamily: 'monospace' }).setOrigin(.5)
  }
  private drawUnit(unit: Unit, ox: number, oy: number, tw: number, th: number) {
    const point = iso(unit.x, unit.y, ox, oy, tw, th); const selected = unit.id === this.state.selectedId; const targeted = unit.id === this.state.targetId
    const marker = this.add.ellipse(point.x, point.y + 9, 44, 17, targeted ? 0xf06464 : selected ? 0xffe07d : 0x101c24, .9).setStrokeStyle(2, targeted ? 0xffb0a5 : selected ? 0xfff2b0 : 0x5c7d8c)
    const body = this.add.circle(point.x, point.y - 19, 16, Number.parseInt(unit.color.slice(1), 16)).setStrokeStyle(3, unit.team === 'player' ? 0xd7f8ff : 0xffd1bd)
    this.add.circle(point.x, point.y - 41, 9, 0xe8d9c3).setStrokeStyle(2, 0x17222b)
    const posture = unit.posture === 'prone' ? 'ЛЁЖА' : unit.posture === 'crouch' ? 'ПРИСЕД' : 'СТОЯ'; const statuses = Object.keys(unit.statuses ?? {}).join(', ') || '—'; const overwatch = unit.overwatch ? '\nOVERWATCH' : ''
    if (unit.overwatch) this.add.ellipse(point.x, point.y + 9, 54, 23).setStrokeStyle(3, 0xffdc83, .95)
    this.add.text(point.x, point.y - 66, `${unit.name}\nHP ${unit.hp}/${unit.maxHp} · ОЧ ${unit.ap}\n${posture}${overwatch}\n${statuses}`, { align: 'center', fontSize: '9px', color: unit.overwatch ? '#ffdc83' : '#f4fbff', fontFamily: 'monospace', stroke: '#0c151b', strokeThickness: 3 }).setOrigin(.5)
    marker.setInteractive({ useHandCursor: true }); body.setInteractive({ useHandCursor: true }); const select = () => this.callbacks.onUnitClick(unit.id); marker.on('pointerdown', select); body.on('pointerdown', select)
  }
}
