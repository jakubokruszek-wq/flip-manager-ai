import assert from "node:assert/strict";
import test from "node:test";
import { classifyFacebookSession } from "./session.ts";

test("detects Facebook login", () => assert.equal(classifyFacebookSession({ url: "https://www.facebook.com/login/", title: "Log into Facebook", visibleText: "Email or phone" }), "FACEBOOK_LOGIN_REQUIRED"));
test("detects expired checkpoint session", () => assert.equal(classifyFacebookSession({ url: "https://www.facebook.com/checkpoint/", title: "Facebook", visibleText: "Session expired" }), "FACEBOOK_SESSION_EXPIRED"));
test("detects challenge", () => assert.equal(classifyFacebookSession({ url: "https://www.facebook.com/", title: "Security check", visibleText: "Complete this CAPTCHA challenge" }), "FACEBOOK_CHALLENGE"));
test("detects access denied", () => assert.equal(classifyFacebookSession({ url: "https://www.facebook.com/groups/1", title: "Facebook", visibleText: "You do not have permission" }), "FACEBOOK_ACCESS_DENIED"));
test("accepts an accessible group", () => assert.equal(classifyFacebookSession({ url: "https://www.facebook.com/groups/1", title: "Group", visibleText: "Newest posts" }), null));

