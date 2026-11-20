import assert from "node:assert/strict";
import test from "node:test";
import { resolveNextDeploymentId } from "./deployment-id.mjs";

test("platform NEXT_DEPLOYMENT_ID owns skew protection without a conflicting custom ID",()=>{
 const id="dpl_Fwk3vGMWqVvtw9c9JHfWy6yLrGGX";
 assert.equal(resolveNextDeploymentId({VERCEL:"1",NEXT_DEPLOYMENT_ID:id,VERCEL_DEPLOYMENT_ID:id}),undefined);
 assert.equal(resolveNextDeploymentId({NEXT_DEPLOYMENT_ID:"self-hosted-id",NEXT_PUBLIC_COMMIT_SHA:"abcd"}),undefined);
});
test("older platform and self-hosted fallbacks remain available without NEXT_DEPLOYMENT_ID",()=>{
 assert.equal(resolveNextDeploymentId({VERCEL:"1",VERCEL_DEPLOYMENT_ID:"dpl_older-platform-id"}),"older-platform-id");
 assert.equal(resolveNextDeploymentId({VERCEL:"1",VERCEL_GIT_COMMIT_SHA:"abcd"}),undefined);
 assert.equal(resolveNextDeploymentId({NEXT_PUBLIC_COMMIT_SHA:"abcd"}),"abcd");
});
