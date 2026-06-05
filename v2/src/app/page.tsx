import Link from "next/link";

export default function Home() {
  return (
    <main className="title-screen">
      <p className="eyebrow">A Harvest-Gothic Soulslike · v2 (WebGL)</p>
      <h1 className="logo">TOMMY TOMATO</h1>
      <p className="sub">Harvest Souls</p>
      <p className="tag">
        Rebuilt on a real renderer — dynamic light, bloom, particles, and
        hand-painted sprites. A tomato. A blade. A field that forgot the season
        ended.
      </p>
      <nav className="menu">
        <Link href="/play" className="primary">
          Enter the Rows
        </Link>
      </nav>
      <p className="foot">
        Next.js · React · PixiJS · static-deployable · PeerJS co-op
      </p>
    </main>
  );
}
