import asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright

PORT = 8765
srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "-d", "test/serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)

async def main():
    proxy = os.environ.get("HTTPS_PROXY")
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
                                          proxy={"server": proxy, "bypass": "localhost,127.0.0.1"} if proxy else None)
        page = await browser.new_page(viewport={"width": 420, "height": 860}, ignore_https_errors=True)
        errors = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        await page.goto(f"http://localhost:{PORT}/index.html")
        await page.wait_for_timeout(4000); await page.click("#bar"); await page.wait_for_timeout(400)
        print("console:", *errors, sep="\n  ")
        log = await page.inner_text("#log"); print("initial log:", log.strip())

        async def load(label, wait):
            await page.click(f"button.chip:has-text('{label}')")
            await page.click("#load")
            await page.wait_for_timeout(wait)
            print(f"\n== after {label} ({wait} ms) ==")
            print(" state:", await page.inner_text("#state"), "| tick:", await page.inner_text("#tick"), "| pos:", await page.inner_text("#s-pos"), "| bat:", await page.inner_text("#s-bat"))
            lines = (await page.inner_text("#log")).strip().splitlines()
            print(" log tail:\n  " + "\n  ".join(lines[-6:]))

        await load("Patrol square", 6000); await page.screenshot(path="test/shot_patrol.png")
        await load("Auto-return to charger", 4000)      # hot swap while running
        # set a target by tapping terrain then load seek_target
        await page.mouse.click(200, 120)
        await load("Go where I tap", 5000)
        await load("Broken module", 10000)              # watchdog must fire
        await page.screenshot(path="test/screenshot.png")
        await browser.close()

try:
    asyncio.run(main())
finally:
    srv.terminate()
