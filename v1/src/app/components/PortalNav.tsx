import Link from "next/link";

const items = [
  { href: "/play", label: "Solo" },
  { href: "/coop", label: "Co-op" },
  { href: "/bestiary", label: "Bestiary" },
  { href: "/lore", label: "Lore" },
  { href: "/controls", label: "Controls" },
];

export default function PortalNav({ active }: { active?: string }) {
  return (
    <nav className="page-nav">
      <Link href="/" className="home">
        <span className="home__pip" aria-hidden />
        <span className="home__name">Tommy Tomato</span>
      </Link>
      <div className="links">
        {items.map((it) => (
          <Link
            key={it.href}
            href={it.href}
            className={active === it.href ? "active" : ""}
            aria-current={active === it.href ? "page" : undefined}
          >
            {it.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
