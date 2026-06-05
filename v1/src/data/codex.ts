// Flavor content for the portal. Cryptic, soil-stained, in the soulslike tradition.

export interface BeastEntry {
  id: string;
  name: string;
  title: string;
  haunt: string;
  threat: 1 | 2 | 3 | 4 | 5;
  desc: string;
  tell: string; // how to fight it
}

export const BESTIARY: BeastEntry[] = [
  {
    id: "mite",
    name: "Soil Mite",
    title: "the Lesser Hunger",
    haunt: "The Rotting Rows · The Sodden Mire",
    threat: 1,
    desc: "Too small to fear and too many to count. Each one wants almost nothing. The trouble is the arithmetic. A field of almost-nothings adds, in the end, to all of you.",
    tell: "Faster than the aphid and barely there. One light tap ends one. Keep moving; standing still is how the sum catches up.",
  },
  {
    id: "aphid",
    name: "Aphid Drone",
    title: "the Many, the Hungry",
    haunt: "The Rotting Rows",
    threat: 1,
    desc: "Alone, an aphid is a nuisance you could flick away. They are never alone. They move as a single green thought, and that thought is sap.",
    tell: "They swarm and dart. Sweep wide with light attacks; do not get surrounded. A heavy attack scatters a clump.",
  },
  {
    id: "grub",
    name: "Cutworm Grub",
    title: "the Soft Engine",
    haunt: "The Rotting Rows · The Catacombs",
    threat: 2,
    desc: "It chews through stem and stalk with patient, idiot devotion. It does not hate you. It simply does not distinguish you from the rest of the harvest.",
    tell: "Slow but its lunge bites hard. Wait for the windup, roll through, punish the recovery.",
  },
  {
    id: "crow",
    name: "Gallows Crow",
    title: "the Patient Auditor",
    haunt: "The Rotting Rows · open sky",
    threat: 2,
    desc: "It remembers every scarecrow that ever failed to frighten it. It has been waiting a long time for something soft enough to be worth the dive.",
    tell: "It circles, then commits to a dive. Lock on and roll the instant it tucks its wings. It is fragile once grounded.",
  },
  {
    id: "hornet",
    name: "Husk Hornet",
    title: "the Quick Grudge",
    haunt: "The Greenhouse · The Sodden Mire",
    threat: 3,
    desc: "It nested in a fallen fruit and took on the temper of the rot inside it. Where the crow deliberates, the hornet has already decided. Its sting is small. Its conviction is not.",
    tell: "It dives sooner and harder than the crow, with almost no warning. Do not wait to read the tell; roll early and to the side, then punish before it climbs again.",
  },
  {
    id: "slug",
    name: "Brine Slug",
    title: "the Salted Tide",
    haunt: "The Greenhouse of Glass",
    threat: 3,
    desc: "It weeps brine that withers everything it touches. Where it has passed, nothing roots again. It is in no hurry. Nothing that leaves salt ever is.",
    tell: "Tanky and slow. Avoid its slime. Circle-strafe and chip it down; its overhead is telegraphed and brutal.",
  },
  {
    id: "weed",
    name: "Strangleweed",
    title: "the Rooted Want",
    haunt: "The Greenhouse · The Catacombs",
    threat: 3,
    desc: "It cannot follow you. It does not need to. It has decided where you will die, and it will wait at that spot with the certainty of something that has never once been wrong.",
    tell: "Rooted but long-reaching. Bait the lunge from outside its arc, then close in. Never linger in its maw.",
  },
  {
    id: "drone",
    name: "Pesticide Sprayer",
    title: "the Mercy of Industry",
    haunt: "The Greenhouse · The Catacombs",
    threat: 3,
    desc: "Built to protect a crop by killing everything that is not the crop. It has never been told that the crop is also you.",
    tell: "Hovers and spits poison from afar. Close the gap with rolls, or wait behind cover and rush between volleys.",
  },
  {
    id: "spore",
    name: "Bloatspore",
    title: "the Generous Wound",
    haunt: "The Greenhouse · The Sodden Mire",
    threat: 3,
    desc: "A puffball swollen past its skin's patience, dragging itself by no method that bears looking at. It does not want to touch you. It only wants to share. What it lobs keeps giving long after it lands.",
    tell: "Its arc is slow and easy to sidestep, but the burst clings and eats at you over time. Never tank one to save a roll. Fight clear of the mist it leaves; do your healing on dry ground.",
  },
  {
    id: "scarecrow",
    name: "Scarecrow Sentinel",
    title: "the Loyal Effigy",
    haunt: "The Greenhouse · The Catacombs",
    threat: 4,
    desc: "Stuffed with last year's straw and a grudge it cannot name. It guards a field that was harvested long ago, against a thief that never came.",
    tell: "Guards frontally and answers with a heavy, committed swing. Roll past its guard and strike the back of the post.",
  },
  {
    id: "beetle",
    name: "Carapace Beetle",
    title: "the Patient Door",
    haunt: "The Compost Catacombs · The Sodden Mire",
    threat: 4,
    desc: "It grew its house on its back and decided that was the whole of safety. It is slow because it has never once needed to hurry. Everything soft eventually comes within reach of something that simply will not break.",
    tell: "Its shell drinks light blows; flailing only feeds it. Land heavy strikes to crack the carapace and stagger it, then open up. The Knuckle of Gourd was made for this work.",
  },
  {
    id: "king",
    name: "The Scarecrow King",
    title: "Hollow of the Husk",
    haunt: "Throne of Straw",
    threat: 5,
    desc: "When enough effigies are left to rot in one place, they agree, in the slow way of straw, to elect a king. He rules a kingdom of crows and is obeyed by none of them.",
    tell: "Sweeps up close, lunges from afar, and summons the swarm when given room. At half-health he comes apart and flails faster. Stay close, stay patient, punish the spin's end.",
  },
  {
    id: "oldtom",
    name: "Old Tom, the First Fruit",
    title: "the One Who Came Before",
    haunt: "The Sodden Mire",
    threat: 5,
    desc: "The first to ripen and the first to go and meet the blade. He was supposed to be the one who ended it. He sank into the mire instead and let his roots take the argument over, and the roots never tire and never doubt and have forgotten what winning was supposed to mean. He is what waits at the far end of being brave for too long.",
    tell: "He fights the way you wish you could, which is the trouble. Read the longer reach of his thrusts and do not greedy-trade. Break his poise at the crest of his combos to buy openings. Beat him and his old pin is yours; he has no more use for keeping anything upright.",
  },
  {
    id: "harvester",
    name: "THE HARVESTER",
    title: "the Last Machine",
    haunt: "The Harvest Yard",
    threat: 5,
    desc: "It does not know the season ended. It does not know the farm was abandoned. It knows only the row ahead and the blade's long want, and it has been harvesting an empty field since before you were a seed.",
    tell: "It charges the length of the yard — sidestep, never outrun. Dodge through the blade sweeps. Its radial sprays demand timed rolls. In overdrive, everything comes faster; bank your heals.",
  },
];

export interface LoreEntry {
  title: string;
  body: string;
}

export const LORE: LoreEntry[] = [
  {
    title: "Of the Harvest, and Why It Comes",
    body: "There was a season, and then there was no season. The farmer left, or died, or simply forgot the way back through his own rows. But the harvest does not require a farmer. It is not a task. It is a hunger the land learned and could not unlearn. Now it comes for everything that ripened — and Tommy, against every instinct of a tomato, has ripened beautifully.",
  },
  {
    title: "The Compost Heap",
    body: "Rest at the heap and the rot will mend you. It remembers the shape of every fruit that fell into it and, for reasons it keeps to itself, has decided to give yours back. Sap spent here is sap spent on becoming. The dead make excellent teachers; they have nothing left to lose by being honest.",
  },
  {
    title: "On Sap, and Its Spilling",
    body: "Sap is what you are made of and what you are worth, which are the same thing, which is the tragedy of it. When you fall, it spills into the soil and waits in a withered husk. Return to where you died and you may reclaim it. Die again before you do, and the soil keeps it. The soil keeps everything, eventually.",
  },
  {
    title: "The Watering Can",
    body: "A cracked tin can, half-rusted, that someone once used to keep a garden alive out of love. It still works, a little. Each pull from it is borrowed life. Refill it at the heap. Do not waste it on scratches; save it for the moment the blade finds you, because the blade always, eventually, finds you.",
  },
  {
    title: "The Phantom Summoning",
    body: "A lone fruit rarely survives the rows. But ripeness calls to ripeness across the strange distance between gardens, and a tomato may reach into another's world as a green phantom — to fight beside them, to bleed beside them, to be paste beside them. There is no harvest so cruel it cannot be made briefly bearable by company.",
  },
  {
    title: "The Heirloom Cultivars",
    body: "Not all tomatoes are red. The ochre, the green-shouldered, the purple heirloom, the frostbit blue that should not exist and does, the pale one the others will not name. Each fell from a different vine. Each arrived at the same conclusion: that survival is the only flavor that matters when the blade is near.",
  },
  {
    title: "Of the First Fruit",
    body: "There was one before you. He ripened first, in a warmer year, and the rows had a hero then. They staked him upright with a long thin pin so he could see the whole field he meant to save, and for a while the story went the way stories are supposed to. Then it did not. He went down into the standing water to root out the rot at its source and he found the source and the source found him, and what climbed back out was mostly roots. Old Tom, they call him now, the ones who still say anything. He is not dead. Dying would have been a kind of finishing, and the mire does not finish things. It only keeps them.",
  },
  {
    title: "The Sodden Mire",
    body: "South of the glass the ground gives up pretending to be ground. Water stands where it pleases and the beds have sunk to their shoulders and everything that grows here grows wrong and grows anyway. The spores took to it first. It is not on the way to anywhere. You go down into the mire for one reason, which is the thing waiting at the bottom of it, which is the reason most people who go down do not come back up still arguing for the way they went in.",
  },
  {
    title: "What the Dead Leave Lying",
    body: "A fruit fights with what the field hands it. A creeper cured stiff. A blackthorn snapped off a hedge. A dried gourd that learned to be a fist. None of it was made to be a weapon; all of it was made into one, the way everything down here is made into something it did not agree to. Old Tom's pin is the worst of them and the best, because it was already a thing for holding the brave in place, and it does not care which of you it holds.",
  },
];
