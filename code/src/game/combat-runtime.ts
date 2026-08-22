import type { ArenaConfig } from "./content";
export type { SceneState } from "./TacticalScene";
import type { SceneState } from "./TacticalScene";

type RuntimeEvents = {
  onCellClick: (x: number, y: number) => void;
  onUnitClick: (id: string) => void;
  onCellHover: (x: number, y: number) => void;
};

export type CombatRuntime = {
  updateState: (state: SceneState) => void;
  destroy: () => void;
};

/** Runtime boundary: Phaser and the scene enter the graph only for an active mission. */
export async function createCombatRuntime(options: {
  host: HTMLElement;
  arena: ArenaConfig;
  state: SceneState;
  events: RuntimeEvents;
}): Promise<CombatRuntime> {
  const [{ default: Phaser }, { TacticalScene }] = await Promise.all([
    import("phaser"),
    import("./TacticalScene"),
  ]);
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: options.host,
    width: 920,
    height: 610,
    transparent: true,
    scene: [TacticalScene],
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  });
  const state = options.state;
  const start = () =>
    game.scene.start("tactical", {
      config: options.arena,
      state,
      events: options.events,
    });
  game.events.once(Phaser.Core.Events.READY, start);

  return {
    updateState(nextState) {
      const scene = game.scene.getScene("tactical") as InstanceType<typeof TacticalScene> | undefined;
      scene?.updateState(nextState);
    },
    destroy() {
      game.destroy(true);
    },
  };
}
