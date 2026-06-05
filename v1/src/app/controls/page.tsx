import PortalNav from "../components/PortalNav";
import HeroSprite from "../components/HeroSprite";
import { WEAPONS, CHARMS, type WeaponKind } from "@/game/content/world";

export const metadata = { title: "Tommy Tomato — How to Survive" };

type Ctrl = { keys: string[]; title: string; desc: string };

// FINAL controls, grouped. Keep this in lock-step with the engine bindings.
const MOVEMENT: Ctrl[] = [
  {
    keys: ["W", "A", "S", "D"],
    title: "Move",
    desc: "Roam the rows. The arrow keys move you too.",
  },
  {
    keys: ["MOUSE"],
    title: "Aim",
    desc: "Tommy faces your cursor. You strike where you look.",
  },
];

const COMBAT: Ctrl[] = [
  {
    keys: ["LMB"],
    title: "Light attack",
    desc: "A quick strike. Cheap on stamina, and the bread of the fight.",
  },
  {
    keys: ["F"],
    title: "Heavy attack",
    desc: "Slow, staggering, and it breaks poise. It hits like a tractor.",
  },
  {
    keys: ["SPACE"],
    title: "Dodge roll",
    desc: "Brief invincibility (i-frames). The whole soul of survival.",
  },
  {
    keys: ["RMB"],
    title: "Guard",
    desc: "Hold to block. A well-timed guard just before a hit is a PARRY.",
  },
  {
    keys: ["RMB"],
    title: "Parry → Riposte",
    desc: "A clean parry staggers the foe and opens a RIPOSTE — a critical thrust.",
  },
  {
    keys: ["⚔"],
    title: "Backstab",
    desc: "Strike an enemy from behind for a heavy BACKSTAB bonus.",
  },
  {
    keys: ["TAB", "Q"],
    title: "Lock-on",
    desc: "Fix your gaze on the nearest foe. Press again to release.",
  },
  {
    keys: ["1", "2", "3", "4"],
    title: "Equip weapon",
    desc: "Swap to any armament you own. Each one is a different fight.",
  },
  {
    keys: ["R", "H"],
    title: "Heal",
    desc: "Pull from the Watering Can. Limited charges; refill at the heap.",
  },
];

const SYSTEM: Ctrl[] = [
  {
    keys: ["E"],
    title: "Rest / Interact",
    desc: "Rest at a Compost Heap to mend, level up, and equip charms — but the fodder returns.",
  },
  { keys: ["P"], title: "Pause", desc: "Hold the harvest a moment." },
];

// Controller (Xbox layout). Plug in a pad and it just works — these fold into
// the same actions as the keyboard/mouse, so you can mix and match mid-fight.
const CONTROLLER: Ctrl[] = [
  { keys: ["LS"], title: "Move", desc: "Left stick walks Tommy through the rows." },
  {
    keys: ["RS"],
    title: "Aim",
    desc: "Right stick aims your strike — Tommy faces wherever you point.",
  },
  { keys: ["RB"], title: "Light attack", desc: "The quick strike. Same as LMB." },
  { keys: ["RT"], title: "Heavy attack", desc: "The poise-breaker. Same as F." },
  { keys: ["A"], title: "Dodge roll", desc: "Roll with i-frames. Same as SPACE." },
  {
    keys: ["LB", "LT"],
    title: "Guard / Parry",
    desc: "Hold to block; time the raise just before a hit to PARRY.",
  },
  {
    keys: ["Y", "R3"],
    title: "Lock-on",
    desc: "Fix the nearest foe. Press again to release.",
  },
  { keys: ["X"], title: "Heal", desc: "Pull from the Watering Can." },
  {
    keys: ["B"],
    title: "Rest / Interact",
    desc: "Rest at a heap, revive on the death screen, and back out of menus.",
  },
  {
    keys: ["D-PAD"],
    title: "Equip weapon",
    desc: "Up / Down / Left / Right swap to armaments 1–4 — and steer the rest menus.",
  },
];

const WEAPON_POSE: Record<WeaponKind, { heavy: boolean }> = {
  whip: { heavy: false },
  dagger: { heavy: false },
  mace: { heavy: true },
  rapier: { heavy: false },
};

const WEAPON_ORDER: WeaponKind[] = ["whip", "dagger", "mace", "rapier"];

function Group({ title, items }: { title: string; items: Ctrl[] }) {
  return (
    <section className="ctrl-group">
      <h2 className="ctrl-group__title">{title}</h2>
      <div className="controls-grid">
        {items.map((c) => (
          <div className="ctrl" key={c.title}>
            <div className="keys">
              {c.keys.map((k, i) => (
                <span
                  className={"key" + (k.length > 2 ? " key--wide" : "")}
                  key={k + i}
                >
                  {k}
                </span>
              ))}
            </div>
            <div className="desc">
              <b>{c.title}</b> — {c.desc}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function ControlsPage() {
  return (
    <main className="page">
      <PortalNav active="/controls" />
      <header className="page-head">
        <h1>How to Survive</h1>
        <p>
          A soulslike in a salad. Stamina is everything — attacking, rolling,
          and blocking all spend it, and an empty tomato is a dead tomato.
          Patience kills. Greed gets you composted. Keyboard &amp; mouse or a{" "}
          <span className="key key--inline">controller</span> — your choice.
        </p>
      </header>

      <Group title="Movement" items={MOVEMENT} />
      <Group title="Combat" items={COMBAT} />
      <Group title="System" items={SYSTEM} />
      <Group title="Controller (Xbox layout)" items={CONTROLLER} />

      {/* weapons gallery */}
      <section className="ctrl-group">
        <h2 className="ctrl-group__title">The Four Armaments</h2>
        <p className="ctrl-group__lede">
          You begin with the Vine Whip. The rest are taken from the field — and
          from what the field took before you. Press <span className="key key--inline">1</span>
          –<span className="key key--inline">4</span> to swap any you own.
        </p>
        <div className="weapon-grid">
          {WEAPON_ORDER.map((id) => {
            const w = WEAPONS[id];
            return (
              <article className="panel weapon-card" key={id}>
                <div className="weapon-card__art">
                  <HeroSprite
                    weapon={id}
                    pose="swing"
                    heavy={WEAPON_POSE[id].heavy}
                    size={120}
                  />
                </div>
                <div className="weapon-card__body">
                  <h3>{w.name}</h3>
                  <p className="weapon-card__flavor">{w.flavor}</p>
                  <div className="weapon-card__stats">
                    <span title="Reach of the swing">
                      reach{" "}
                      <b>
                        {w.reach >= 64
                          ? "long"
                          : w.reach >= 50
                          ? "medium"
                          : w.reach >= 40
                          ? "short-mid"
                          : "short"}
                      </b>
                    </span>
                    <span title="Swing speed">
                      speed{" "}
                      <b>
                        {w.speedMul <= 0.7
                          ? "fast"
                          : w.speedMul < 1
                          ? "brisk"
                          : w.speedMul <= 1.05
                          ? "medium"
                          : "slow"}
                      </b>
                    </span>
                    {w.special && (
                      <span className="weapon-card__special" title="Signature">
                        {w.special}
                      </span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* the loop */}
      <section className="ctrl-group">
        <div className="rule rule--label">
          <span className="rule__pip" />
          <span className="rule__text">The Loop of the Rows</span>
          <span className="rule__pip" />
        </div>
        <ol className="loop">
          <li>
            <b>Cut.</b> Slay the field&rsquo;s creatures for{" "}
            <span className="sap">sap</span> — backstab, parry, and pace your
            stamina to live.
          </li>
          <li>
            <b>Rest.</b> At a <span className="tomato">Compost Heap</span>, spend
            sap on Vigor, Strength, Vitality, or Agility — and slot the charms
            you&rsquo;ve found.
          </li>
          <li>
            <b>Fall.</b> Die and your sap spills into a{" "}
            <span className="tomato">husk</span> where you dropped. Reclaim it —
            but die again first and the soil keeps it.
          </li>
          <li>
            <b>Descend.</b> Push from the Rows through the Greenhouse, down into
            the <span className="sap">Sodden Mire</span> after Old Tom, and on to
            the great foes beyond. The blade is patient. You should not be.
          </li>
        </ol>
      </section>

      {/* charms appendix */}
      <section className="ctrl-group">
        <h2 className="ctrl-group__title">Charms of the Field</h2>
        <p className="ctrl-group__lede">
          Passive trinkets, slotted while resting at a heap. Each is a small
          bargain with the rot.
        </p>
        <div className="charm-grid">
          {CHARMS.map((c) => (
            <div className="charm" key={c.id}>
              <span className="charm__pip" aria-hidden />
              <div>
                <b className="charm__name">{c.name}</b>
                <p className="charm__flavor">{c.flavor}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
