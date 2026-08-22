import assert from "node:assert/strict";
import test from "node:test";
import { assertFacebookPostsBelongToGroup, parseFacebookGroupSnapshot } from "./completion.ts";

const groupA = { id: "group-a", name: "Group A", url: "https://www.facebook.com/groups/group-a/" };
const groupB = { id: "group-b", name: "Group B", url: "https://www.facebook.com/groups/group-b/" };

test("parses exactly one group bound to a queue job", () => assert.deepEqual(parseFacebookGroupSnapshot([groupA]), groupA));
test("job A accepts only posts from group A", () => assert.doesNotThrow(() => assertFacebookPostsBelongToGroup([{ groupId: "group-a" }], groupA)));
test("job B accepts only posts from group B", () => assert.doesNotThrow(() => assertFacebookPostsBelongToGroup([{ groupId: "group-b" }], groupB)));
test("completion rejects a post from another group", () => assert.throws(() => assertFacebookPostsBelongToGroup([{ groupId: "group-b" }], groupA), /FACEBOOK_GROUP_MISMATCH/));
