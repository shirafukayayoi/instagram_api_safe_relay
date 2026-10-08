// 外部サイト・実アカウントを使わず、ブラウザの選択と保存フローを検証する手動smoke。
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createHighlightBrowser } from "../src/highlights/browser.js";

const engine = await chromium.launch({ headless: true });
const context = await engine.newContext();
context.on("page", (page) => page.on("pageerror", (error) => console.error("模擬画面:", error.message)));
let selected = ["100"];
let saves = 0;
let recorded = false;
const account = { id: "123", username: "owner" };
const highlight = { id: "456", title: "idol" };
const html = () => String.raw`<!doctype html><html lang="en"><body><script>
window.require = name => name === 'PolarisViewer' ? {id:'123', data:{username:'owner'}} : {get:()=> '123'};
let selected = ${JSON.stringify(selected)};
function viewer() { document.body.innerHTML = '<button aria-label="Menu" onclick="menu()">Menu</button>'; }
function menu() { document.body.innerHTML = '<button onclick="editor()">Edit</button>'; }
function editor() { document.body.innerHTML = '<input value="idol"><button onclick="selection(\'Selected\')">Next</button>'; }
function selection(tab) {
  document.body.innerHTML = '<button role="tab" onclick="selection(\'Selected\')">Selected</button><button role="tab" onclick="selection(\'Stories\')">Stories</button><div id="grid"></div><button onclick="cover()">Next</button>';
  const items = tab === 'Selected' ? selected : ['100','999','777'];
  for (const id of items) {
    const button = document.createElement('div'); button.setAttribute('role','button');
    const image = document.createElement('div'); image.style.backgroundImage = 'url("https://media.example/' + id + '.jpg?ig_cache_key=' + encodeURIComponent(btoa(id)) + '.3")'; image.style.width='100px'; image.style.height='100px';
    button.append(image); button.onclick = () => { selected = selected.includes(id) ? selected.filter(item=>item!==id) : [...selected,id]; selection(tab); };
    document.getElementById('grid').append(button);
  }
}
function cover() { document.body.innerHTML = '<img alt="Cover" src="data:,original-cover"><button onclick="save()">Done</button>'; }
async function save() { await fetch('/__test/save',{method:'POST',body:JSON.stringify(selected)}); viewer(); }
if (location.pathname.startsWith('/stories/highlights/')) viewer();
else document.body.innerHTML = '<a href="/stories/highlights/456/">idol</a>';
</script></body></html>`;

await context.route("**/*", async (route) => {
	const request = route.request();
	if (new URL(request.url()).pathname === "/__test/save") {
		assert.equal(recorded, true, "保存より先に台帳が記録されること");
		selected = JSON.parse(request.postData() ?? "[]");
		assert.deepEqual(selected, ["100", "999"], "既存の動画を保ち、指定した動画だけを追加すること");
		saves += 1;
		await route.fulfill({ contentType: "application/json", body: "{}" });
	} else if (new URL(request.url()).origin === "https://www.instagram.com") {
		await route.fulfill({ contentType: "text/html", body: html() });
	} else await route.abort();
});
try {
	const source = await context.newPage();
	const adapter = await createHighlightBrowser(source, new AbortController().signal);
	try {
		assert.equal(
			await adapter.add(highlight, "999", account, async () => {
				recorded = true;
			}),
			false,
		);
		assert.equal(saves, 1);
		assert.equal(
			await adapter.add(highlight, "999", account, async () => {
				assert.fail("登録済みの保存は不要");
			}),
			true,
		);
		assert.equal(saves, 1);
		await assert.rejects(
			adapter.add(highlight, "777", { id: "321", username: "another" }, async () => {
				assert.fail("別アカウントでは保存しない");
			}),
			(error) => (error as { code?: string }).code === "ACCOUNT_CHANGED",
		);
		console.log(
			"ハイライトUI smoke: 対象照合・選択保持・保存前記録・保存後確認・登録済み・アカウント変更を検証しました",
		);
	} finally {
		await adapter.close();
	}
} finally {
	await context.close();
	await engine.close();
}
