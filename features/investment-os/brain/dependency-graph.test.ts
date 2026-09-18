import assert from "node:assert/strict";
import test from "node:test";
import { BRAIN_DIRECTORS } from "./types.ts";
import { DEAL_BRAIN_DEPENDENCIES, dealBrainEdges, dependenciesFor, topologicalDirectorOrder, validateDealBrainGraph } from "./dependency-graph.ts";
import type { BrainDependencyDefinition } from "./types.ts";

test("the real registry covers exactly the ten mission directors and validates without throwing", () => {
  assert.deepEqual(DEAL_BRAIN_DEPENDENCIES.map((item) => item.director).sort(), [...BRAIN_DIRECTORS].sort());
  assert.doesNotThrow(() => validateDealBrainGraph());
});

test("CEO depends on all nine other directors and no other director depends on CEO", () => {
  assert.deepEqual(dependenciesFor("CEO").sort(), BRAIN_DIRECTORS.filter((id) => id !== "CEO").sort());
  for (const id of BRAIN_DIRECTORS) if (id !== "CEO") assert.ok(!dependenciesFor(id).includes("CEO"), `${id} must not depend on CEO`);
});

test("topological order places every director after all of its dependencies", () => {
  const order = topologicalDirectorOrder();
  assert.equal(order[0], "SCOUT");
  assert.equal(order[order.length - 1], "CEO");
  const index = new Map(order.map((id, position) => [id, position]));
  for (const definition of DEAL_BRAIN_DEPENDENCIES) for (const dependency of definition.dependsOnDirectors) assert.ok(index.get(dependency)! < index.get(definition.director)!, `${dependency} must be ordered before ${definition.director}`);
});

test("a cyclic node list is rejected before any traversal completes", () => {
  const cyclic: BrainDependencyDefinition[] = [
    { director: "SCOUT", dependsOnDirectors: ["CEO"], dependsOnFields: [], rationale: "test" },
    { director: "CEO", dependsOnDirectors: ["SCOUT"], dependsOnFields: [], rationale: "test" },
  ];
  assert.throws(() => validateDealBrainGraph(cyclic), /DEAL_BRAIN_DEPENDENCY_CYCLE/);
});

test("a dependency referencing an unregistered director is rejected", () => {
  const incomplete: BrainDependencyDefinition[] = [{ director: "SCOUT", dependsOnDirectors: ["VERIFY"], dependsOnFields: [], rationale: "test" }];
  assert.throws(() => validateDealBrainGraph(incomplete), /DEAL_BRAIN_DEPENDENCY_NODE_MISSING/);
});

test("dependency edges only connect registered directors and carry the declared fields", () => {
  const edges = dealBrainEdges();
  assert.ok(edges.length > 0);
  for (const edge of edges) {
    assert.ok(BRAIN_DIRECTORS.includes(edge.from));
    assert.ok(BRAIN_DIRECTORS.includes(edge.to));
    assert.ok(Array.isArray(edge.fields));
  }
});
