import PortalNav from "../components/PortalNav";
import { LORE } from "@/data/codex";

export const metadata = { title: "Tommy Tomato — Lore of the Rows" };

export default function LorePage() {
  return (
    <main className="page">
      <PortalNav active="/lore" />
      <header className="page-head">
        <h1>Lore of the Rows</h1>
        <p>
          Fragments scratched into seed packets and fence posts. Read them, or
          don&rsquo;t. The harvest comes either way.
        </p>
      </header>

      <div className="lore-scroll">
        {LORE.map((l, i) => (
          <article key={l.title} className="panel lore-entry">
            <div className="lore-entry__mark" aria-hidden>
              {String(i + 1).padStart(2, "0")}
            </div>
            <h3>{l.title}</h3>
            <p className="lore-entry__body dropcap">{l.body}</p>
          </article>
        ))}
      </div>

      <p className="lore-foot">
        <span className="rule">
          <span className="rule__pip" />
        </span>
        The soil keeps everything, eventually.
      </p>
    </main>
  );
}
