import Link from "next/link";
import TitleTomato from "./components/TitleTomato";

// CSS-driven embers drift behind the scene canvas for layered depth; the
// canvas paints its own foreground motes on top. Cheap, GPU-friendly, and they
// idle quietly behind everything (z-index handled in globals.css).
function Embers() {
  const seeds = Array.from({ length: 28 });
  return (
    <div className="embers" aria-hidden>
      {seeds.map((_, i) => {
        const left = (i * 37) % 100;
        const dur = 8 + ((i * 13) % 10);
        const delay = (i * 0.7) % 10;
        const size = 2 + (i % 3);
        const drift = (i % 2 ? 1 : -1) * (20 + (i % 4) * 14);
        return (
          <span
            key={i}
            className="ember"
            style={
              {
                left: `${left}%`,
                width: size,
                height: size,
                animationDuration: `${dur}s`,
                animationDelay: `${delay}s`,
                "--drift": `${drift}px`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

export default function Home() {
  return (
    <main className="title-screen">
      <Embers />

      <div className="title-inner">
        <p className="title-eyebrow rise">
          <span className="title-eyebrow__pip" /> A Harvest-Gothic Soulslike
        </p>

        <h1 className="title-logo rise-2">
          <span className="title-logo__top">TOMMY</span>
          <span className="title-logo__of">the saga of</span>
          <span className="title-logo__bottom">TOMATO</span>
        </h1>
        <p className="title-sub rise-2">
          <span className="title-sub__rule" />
          Harvest Souls
          <span className="title-sub__rule" />
        </p>

        <div className="title-scene rise-3">
          <TitleTomato />
        </div>

        <p className="title-tag rise-3">
          A tomato. A blade. A field that forgot the season ended. Roll, parry,
          and ripen against the agricultural hellscape — or summon a friend to be
          paste beside you.
        </p>

        <nav className="menu rise-4" aria-label="Main menu">
          <Link href="/play" className="menu__item primary">
            <span className="menu__label">Descend Alone</span>
            <span className="menu__sub">begin the solo harvest</span>
          </Link>
          <Link href="/coop" className="menu__item">
            <span className="menu__label">Co-op</span>
            <span className="menu__sub">summon &amp; be summoned</span>
          </Link>
          <Link href="/bestiary" className="menu__item">
            <span className="menu__label">Bestiary</span>
            <span className="menu__sub">a field guide to the rot</span>
          </Link>
          <Link href="/lore" className="menu__item">
            <span className="menu__label">Lore of the Rows</span>
            <span className="menu__sub">fragments from the soil</span>
          </Link>
          <Link href="/controls" className="menu__item">
            <span className="menu__label">How to Survive</span>
            <span className="menu__sub">controls &amp; the loop</span>
          </Link>
        </nav>

        <p className="title-foot rise-4">
          Built with Next.js &amp; React · co-op runs peer-to-peer in your
          browser · <Link href="/controls">controls</Link>
        </p>
      </div>
    </main>
  );
}
