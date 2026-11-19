/**
 * graphology packages are CommonJS: at runtime the default import *is* the class/function, but under
 * "moduleResolution: NodeNext" TypeScript types it as the module namespace. Re-export with the right types.
 */
import GraphNs from "graphology";
import louvainNs from "graphology-communities-louvain";
import pagerankNs from "graphology-metrics/centrality/pagerank.js";
import betweennessNs from "graphology-metrics/centrality/betweenness.js";

type Cjs<T> = T extends { default: infer D } ? D : T;

export const Graph = GraphNs as unknown as Cjs<typeof GraphNs>;
export type GraphInstance = InstanceType<typeof Graph>;
export const louvain = louvainNs as unknown as Cjs<typeof louvainNs>;
export const pagerank = pagerankNs as unknown as Cjs<typeof pagerankNs>;
export const betweenness = betweennessNs as unknown as Cjs<typeof betweennessNs>;
