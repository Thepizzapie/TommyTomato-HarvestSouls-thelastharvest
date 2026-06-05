import PortalNav from "../components/PortalNav";
import BeastThumb from "../components/BeastThumb";
import { BESTIARY } from "@/data/codex";
import type { EnemyKind } from "@/game/core/art";

export const metadata = { title: "Tommy Tomato — Bestiary" };

// Each codex entry's id is also its drawable EnemyKind. We keep an explicit
// allow-list so a typo in the data can't silently mount a blank canvas, and so
// the map stays type-checked against the art module.
const KIND: Record<string, EnemyKind> = {
  mite: "mite",
  aphid: "aphid",
  grub: "grub",
  crow: "crow",
  hornet: "hornet",
  slug: "slug",
  weed: "weed",
  drone: "drone",
  spore: "spore",
  scarecrow: "scarecrow",
  beetle: "beetle",
  king: "king",
  oldtom: "oldtom",
  harvester: "harvester",
};

const THREAT_LABEL = ["", "Fodder", "Minor", "Dangerous", "Deadly", "Apex"];

export default function BestiaryPage() {
  const bosses = BESTIARY.filter((b) => b.threat === 5);
  const rabble = BESTIARY.filter((b) => b.threat < 5);

  return (
    <main className="page">
      <PortalNav active="/bestiary" />
      <header className="page-head">
        <h1>Bestiary</h1>
        <p>
          The things the field has become. Study them; the rows do not forgive a
          second mistake, and rarely the first. Each portrait shows the beast at
          rest, then its tell — watch once before you meet it.
        </p>
        <div className="legend">
          <span className="legend__item">
            <span className="threat threat--mini">
              {[0, 1, 2].map((i) => (
                <span key={i} className={"pip " + (i < 1 ? "on" : "")} />
              ))}
            </span>
            threat rating
          </span>
          <span className="legend__item legend__tell">tell — how it kills</span>
        </div>
      </header>

      <div className="codex">
        {rabble.map((b) => (
          <BeastCard key={b.id} beast={b} />
        ))}
      </div>

      <div className="rule rule--label">
        <span className="rule__pip" />
        <span className="rule__text">Those That Wait at the End</span>
        <span className="rule__pip" />
      </div>

      <div className="codex codex--bosses">
        {bosses.map((b) => (
          <BeastCard key={b.id} beast={b} boss />
        ))}
      </div>
    </main>
  );
}

function BeastCard({
  beast: b,
  boss = false,
}: {
  beast: (typeof BESTIARY)[number];
  boss?: boolean;
}) {
  const kind = KIND[b.id];
  return (
    <article className={"panel beast" + (boss ? " beast--boss" : "")}>
      <div className="beast__portrait">
        {kind ? <BeastThumb kind={kind} size={boss ? 132 : 104} /> : null}
        <span className="beast__threat-badge" title={`Threat ${b.threat} of 5`}>
          {THREAT_LABEL[b.threat]}
        </span>
      </div>
      <div className="beast__body">
        <div className="threat" title={`Threat ${b.threat} of 5`}>
          {Array.from({ length: 5 }).map((_, i) => (
            <span key={i} className={"pip " + (i < b.threat ? "on" : "")} />
          ))}
        </div>
        <h3>{b.name}</h3>
        <div className="title">{b.title}</div>
        <div className="haunt">{b.haunt}</div>
        <p className="desc">{b.desc}</p>
        <p className="tell">
          <span className="tell__label">Tell</span>
          {b.tell}
        </p>
      </div>
    </article>
  );
}
