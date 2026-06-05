import GameClient from "../components/GameClient";

export const metadata = { title: "Tommy Tomato — Solo Descent" };

export default function PlayPage() {
  return <GameClient mode="solo" />;
}
