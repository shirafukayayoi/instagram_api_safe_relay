import { chromium } from "playwright";
import { createInstagramBrowser } from "instagram-api-safe-request";

const context = await chromium.launchPersistentContext("./user_data/example", { headless: false });
const page = await context.newPage();
const instagram = createInstagramBrowser(page);

await instagram.inject();
await instagram.goto();

const profile = await instagram.execute("getPublicProfile", { username: "instagram" });
console.log(profile);

await context.close();
