/** Build step: download the embedding model once so the first request doesn't wait for it. */
import { embed } from "./embed.js";

const [v] = await embed(["warm up"], true);
console.log(`embedding model ready (${v.length} dims)`);
