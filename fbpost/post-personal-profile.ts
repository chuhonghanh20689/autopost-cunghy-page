import { chromium, BrowserContext, Locator, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const FILE_VERSION = "PAGE_POST_V11_MAYBE_LATER_FIXED_2026-09-17";

type Caption = {
  keyword: string;
  content: string;
  hashtags: string[];
  fullCaption: string;
};

type SavedCaptions = {
  campaign: string;
  generatedAt: string;
  captions: Caption[];
};

type Campaign = {
  name: string;
  imageFolder: string;
  imageCount?: number;
  randomImages?: boolean;
  mainKeyword: string;
  primaryKeywords?: string[];
  productKeywords?: string[];
  audienceKeywords?: string[];
  angles?: string[];
  hashtags?: string[];
  secondaryOccasions?: string[];
  instruction?: string;
};

type PagePostingState = {
  campaign: string;
  nextCaptionIndex: number;
};

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const CAMPAIGNS_DIR = path.join(ROOT, "campaigns");

const CAPTIONS_FILE = path.join(DATA_DIR, "captions.json");
const STATE_FILE = path.join(
  DATA_DIR,
  "page-posting-state.json"
);

const CAMPAIGN_CONFIG_FILE = path.join(
  ROOT,
  "config",
  "campaign-config.json"
);
const TEST_MODE = false;
const ACTION_TIMEOUT = 15_000;

/*
 * Cùng profile Facebook đang dùng cho project hiện tại.
 * Không tạo profile/login mới.
 */
const PROFILE_DIR = path.join(
  ROOT,
  ".browser-profile"
);

function readJson<T>(file: string): T {
  if (!fs.existsSync(file)) {
    throw new Error(`Không tìm thấy file:\n${file}`);
  }

  return JSON.parse(
    fs.readFileSync(file, "utf8")
  ) as T;
}

function writeJson(
  file: string,
  data: unknown
): void {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}



function shuffle<T>(array: T[]): T[] {
  const result = [...array];

  for (
    let i = result.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(
        Math.random() * (i + 1)
      );

    [result[i], result[j]] =
      [result[j], result[i]];
  }

  return result;
}

function getCurrentCampaignName(): string {
  const config =
    readJson<{
      currentCampaign?: string;
      campaign?: string;
      current?: string;
    }>(CAMPAIGN_CONFIG_FILE);

  const campaignName =
    config.currentCampaign ??
    config.campaign ??
    config.current;

  if (
    typeof campaignName === "string" &&
    campaignName.trim()
  ) {
    return campaignName.trim();
  }

  throw new Error(
    "Không xác định được currentCampaign trong campaign-config.json."
  );
}

function loadCampaign(
  campaignName: string
): Campaign {
  const file = path.join(
    CAMPAIGNS_DIR,
    `${campaignName}.json`
  );

  if (!fs.existsSync(file)) {
    throw new Error(
      `Không tìm thấy campaign:\n${file}`
    );
  }

  return readJson<Campaign>(file);
}

function getImages(
  imageFolder: string
): string[] {
  if (!fs.existsSync(imageFolder)) {
    throw new Error(
      `Không tìm thấy imageFolder:\n${imageFolder}`
    );
  }

  const allowedExtensions =
    new Set([
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".bmp"
    ]);

  const files =
    fs
      .readdirSync(imageFolder)
      .filter((file) =>
        allowedExtensions.has(
          path.extname(file).toLowerCase()
        )
      )
      .map((file) =>
        path.join(
          imageFolder,
          file
        )
      );

  if (files.length === 0) {
    throw new Error(
      `Không có ảnh hợp lệ trong:\n${imageFolder}`
    );
  }

  return files;
}

function loadState(
  campaignName: string
): PagePostingState {
  if (!fs.existsSync(STATE_FILE)) {
    const initialState: PagePostingState = {
      campaign: campaignName,
      nextCaptionIndex: 0
    };

    writeJson(
      STATE_FILE,
      initialState
    );

    return initialState;
  }

  const state =
    readJson<PagePostingState>(
      STATE_FILE
    );

  /*
   * Campaign đổi:
   * reset vòng caption về đầu.
   */
  if (
    state.campaign !==
    campaignName
  ) {
    console.log(
      `🔄 Campaign đổi: ${state.campaign || "(trống)"} → ${campaignName}`
    );

    state.campaign =
      campaignName;
    state.nextCaptionIndex = 0;

    writeJson(
      STATE_FILE,
      state
    );

    return state;
  }

  return state;
}

async function waitForFacebook(
  page: Page
): Promise<void> {
  const url =
    page.url().toLowerCase();

  if (
    url.includes("/login") ||
    url.includes("/checkpoint") ||
    url.includes("/two_step_verification")
  ) {
    throw new Error(
      "Facebook chưa ở trạng thái đăng nhập ổn định."
    );
  }

  await page.waitForTimeout(1_500);
}

async function findVisibleText(
  page: Page,
  patterns: RegExp[]
): Promise<Locator | null> {
  for (const pattern of patterns) {
    const locator =
      page.getByText(pattern).last();

    if (
      await locator
        .isVisible()
        .catch(() => false)
    ) {
      return locator;
    }
  }

  return null;
}

/* ============================================================
   FACEBOOK PAGE COMPOSER
============================================================ */

async function dismissCustomerChatPopup(page: Page): Promise<void> {
  /* V9: Facebook's "Chat directly with customers" popup is sometimes
     rendered outside the dialog subtree Playwright initially sees.
     Therefore the primary action is now a GLOBAL visible BUTTON search
     for the exact text "Not now". We deliberately target actual button /
     role=button elements before falling back to text nodes. */
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const titleVisible = await page
      .getByText('Chat directly with customers', { exact: true })
      .last()
      .isVisible()
      .catch(() => false);

    if (!titleVisible) return;

    console.log('⚠️ Customer chat popup detected → bắt buộc click "Not now".');

    // 1) FIRST: actual <button> elements with exact visible "Not now".
    const buttonCandidates: Locator[] = [
      page.locator('button').filter({ hasText: /^Not now$/i }),
      page.locator('[role="button"]').filter({ hasText: /^Not now$/i }),
      page.getByRole('button', { name: /^Not now$/i })
    ];

    let clicked = false;

    for (const candidate of buttonCandidates) {
      const count = await candidate.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = candidate.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;

        console.log('➡️ Click đúng nút "Not now"...');
        await el.scrollIntoViewIfNeeded().catch(() => {});

        try {
          await el.click({ timeout: ACTION_TIMEOUT, force: true });
          clicked = true;
        } catch {
          // Try a DOM click below; Facebook can temporarily intercept Playwright's click.
          await el.evaluate((node) => (node as HTMLElement).click()).catch(() => {});
          clicked = true;
        }

        await page.waitForTimeout(1_000);

        const stillVisible = await page
          .getByText('Chat directly with customers', { exact: true })
          .last()
          .isVisible()
          .catch(() => false);

        if (!stillVisible) {
          console.log('✅ Đã đóng customer chat popup bằng Not now.');
          return;
        }
      }
    }

    // 2) SECOND: visible exact text "Not now" (some FB builds use a div/span).
    if (!clicked) {
      const textCandidates = page.getByText('Not now', { exact: true });
      const count = await textCandidates.count().catch(() => 0);

      for (let i = 0; i < count; i++) {
        const el = textCandidates.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;

        console.log('➡️ Click text "Not now"...');
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: ACTION_TIMEOUT, force: true }).catch(async () => {
          await el.evaluate((node) => (node as HTMLElement).click()).catch(() => {});
        });
        await page.waitForTimeout(1_000);

        const stillVisible = await page
          .getByText('Chat directly with customers', { exact: true })
          .last()
          .isVisible()
          .catch(() => false);

        if (!stillVisible) {
          console.log('✅ Đã đóng customer chat popup bằng Not now.');
          return;
        }
      }
    }

    // 3) THIRD: X button of the actual popup.
    const closeCandidates: Locator[] = [
      page.locator('[aria-label="Close"]'),
      page.locator('[aria-label="Đóng"]'),
      page.locator('button[title="Close"]'),
      page.locator('button[title="Đóng"]')
    ];

    for (const candidate of closeCandidates) {
      const count = await candidate.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = candidate.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;

        console.log('⚠️ Không click được Not now → click X của popup.');
        await el.click({ timeout: ACTION_TIMEOUT, force: true }).catch(async () => {
          await el.evaluate((node) => (node as HTMLElement).click()).catch(() => {});
        });
        await page.waitForTimeout(1_000);

        const stillVisible = await page
          .getByText('Chat directly with customers', { exact: true })
          .last()
          .isVisible()
          .catch(() => false);

        if (!stillVisible) return;
      }
    }

    // 4) FINAL fallback.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(800);
  }

  throw new Error(
    'Facebook popup "Chat directly with customers" vẫn còn sau khi đã thử click Not now.'
  );
}

async function dismissCustomerChatPopupRepeated(
  page: Page,
  attempts = 5
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const visible = await page
      .getByText("Chat directly with customers", { exact: true })
      .last()
      .isVisible()
      .catch(() => false);

    if (!visible) return;

    console.log(`🔄 Xử lý customer chat popup lần ${i + 1}/${attempts}...`);
    await dismissCustomerChatPopup(page);
    await page.waitForTimeout(500);
  }

  const visible = await page
    .getByText("Chat directly with customers", { exact: true })
    .last()
    .isVisible()
    .catch(() => false);

  if (visible) {
    throw new Error(
      'Không thể đóng popup "Chat directly with customers" sau nhiều lần thử.'
    );
  }
}


async function getComposerDialog(
  page: Page
): Promise<Locator | null> {
  /*
   * Facebook có thể có nhiều dialog cùng lúc.
   * TUYỆT ĐỐI không coi mọi dialog có textbox là composer,
   * vì popup Chat / Messenger cũng có thể chứa textbox.
   *
   * Chỉ nhận dialog có dấu hiệu rõ ràng của luồng tạo bài:
   * Create a post / What's on your mind / Post settings / Post preview
   * hoặc có nút Post/Đăng của composer.
   */
  await dismissCustomerChatPopupRepeated(page);

  const dialogs = page.locator('[role="dialog"]');
  const count = await dialogs.count();

  const composerTexts = [
    "Create a post",
    "Tạo bài viết",
    "What's on your mind?",
    "Bạn đang nghĩ gì",
    "Post settings",
    "Cài đặt bài viết",
    "Post preview",
    "Xem trước bài viết"
  ];

  for (let i = count - 1; i >= 0; i--) {
    const dialog = dialogs.nth(i);

    if (!(await dialog.isVisible().catch(() => false))) {
      continue;
    }

    const text = await dialog.innerText().catch(() => "");

    if (/Chat directly with customers/i.test(text)) {
      continue;
    }

    const hasComposerText = composerTexts.some((value) =>
      text.includes(value)
    );

    const hasPostButton =
      await dialog
        .locator(
          '[aria-label="Post"], [aria-label="Đăng"], button:has-text("Post"), button:has-text("Đăng"), div[role="button"]:has-text("Post"), div[role="button"]:has-text("Đăng")'
        )
        .count()
        .catch(() => 0);

    if (hasComposerText || hasPostButton > 0) {
      return dialog;
    }
  }

  return null;
}


async function findComposer(
  page: Page
): Promise<Locator | null> {
  /*
   * Chỉ tìm composer ở trang Page khi CHƯA có dialog.
   * Nếu dialog đã mở thì tuyệt đối không click lại composer
   * phía sau, vì Facebook có thể re-render toàn bộ trang.
   */
  const existingDialog =
    await getComposerDialog(page);

  if (existingDialog) {
    return existingDialog;
  }

  const exactTexts = [
    "Write something...",
    "Create a post",
    "Tạo bài viết",
    "Bạn đang nghĩ gì",
    "What's on your mind?"
  ];

  for (const text of exactTexts) {
    const locator =
      page
        .getByText(
          text,
          { exact: true }
        )
        .last();

    if (
      await locator
        .isVisible()
        .catch(() => false)
    ) {
      return locator;
    }
  }

  const selectors = [
    '[aria-label*="Create a post"]',
    '[aria-label*="Tạo bài viết"]',
    '[aria-label*="Bạn đang nghĩ gì"]',
    '[aria-label*="What\'s on your mind"]',
    '[role="button"]:has-text("Write something")',
    '[role="button"]:has-text("What\'s on your mind")',
    '[role="button"]:has-text("Bạn đang nghĩ gì")'
  ];

  for (const selector of selectors) {
    const locator =
      page
        .locator(selector)
        .last();

    if (
      await locator
        .isVisible()
        .catch(() => false)
    ) {
      return locator;
    }
  }

  return null;
}

async function openComposer(
  page: Page
): Promise<void> {
  /*
   * Nếu Facebook đã mở composer rồi thì dùng luôn.
   * Không click thêm lần nữa.
   */
  const existingDialog =
    await getComposerDialog(page);

  if (existingDialog) {
    console.log("✅ Composer đã mở sẵn.");
    return;
  }

  const composer =
    await findComposer(page);

  if (!composer) {
    throw new Error(
      "Không tìm thấy ô tạo bài viết trên Facebook Page."
    );
  }

  await composer.click({
    timeout: ACTION_TIMEOUT
  });

  /*
   * Chờ đúng modal Create post xuất hiện.
   * Không dựa vào timeout cố định 1.5s.
   */
  const deadline =
    Date.now() + 15_000;

  while (Date.now() < deadline) {
    const dialog =
      await getComposerDialog(page);

    if (dialog) {
      console.log("✅ Create post composer đã mở.");
      await page.waitForTimeout(700);
      return;
    }

    await page.waitForTimeout(300);
  }

  throw new Error(
    "Facebook đã click composer nhưng không mở Create post dialog."
  );
}

async function findPostTextbox(
  page: Page
): Promise<Locator | null> {
  /*
   * Ưu tiên textbox nằm trong Create post dialog.
   */
  const dialog =
    await getComposerDialog(page);

  const selectors = [
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'div[role="textbox"]',
    'textarea',
    '[aria-label*="What\'s on your mind"]',
    '[aria-label*="Bạn đang nghĩ gì"]'
  ];

  if (dialog) {
    for (const selector of selectors) {
      const locators =
        dialog.locator(selector);

      const count =
        await locators.count().catch(() => 0);

      for (let i = count - 1; i >= 0; i--) {
        const locator = locators.nth(i);

        if (
          await locator
            .isVisible()
            .catch(() => false)
        ) {
          return locator;
        }
      }
    }
  }

  /*
   * Fallback quan trọng:
   * Một số phiên bản Facebook render ô nhập caption bên ngoài
   * [role="dialog"], dù modal Create post vẫn đang hiển thị.
   */
  for (const selector of selectors) {
    const locators =
      page.locator(selector);

    const count =
      await locators.count().catch(() => 0);

    for (let i = count - 1; i >= 0; i--) {
      const locator = locators.nth(i);

      if (
        await locator
          .isVisible()
          .catch(() => false)
      ) {
        return locator;
      }
    }
  }

  return null;
}

async function fillCaption(
  page: Page,
  caption: string
): Promise<void> {
  const textbox =
    await findPostTextbox(page);

  if (!textbox) {
    /*
     * Chờ thêm một chút vì Facebook đôi khi render modal trước,
     * rồi mới mount contenteditable.
     */
    const deadline = Date.now() + 8_000;

    while (Date.now() < deadline) {
      await page.waitForTimeout(500);

      const retryTextbox =
        await findPostTextbox(page);

      if (retryTextbox) {
        await retryTextbox.click();
        await retryTextbox.fill(caption);
        await page.waitForTimeout(700);
        return;
      }
    }

    throw new Error(
      "Không tìm thấy ô nhập caption trong Create post dialog."
    );
  }

  await textbox.click();
  await textbox.fill(caption);

  await page.waitForTimeout(700);
}

/*
 * Facebook có thể mở popup gợi ý sau khi nhập caption.
 * Đóng popup trước khi tìm Photo/video.
 */
async function dismissComposerSuggestions(
  page: Page
): Promise<void> {
  /*
   * KHÔNG click tiêu đề "Create post".
   *
   * Facebook có thể re-render composer khi tiêu đề bị click,
   * khiến trang phía sau giật/reload và Playwright mất target.
   *
   * Nếu có suggestion popup thực sự phủ lên composer thì chỉ
   * dùng Escape; còn bình thường không làm gì.
   */
  const dialog =
    await getComposerDialog(page);

  if (!dialog) {
    return;
  }

  const bodyText =
    await dialog
      .innerText()
      .catch(() => "");

  if (
    /suggest|gợi ý|switch|chọn trang/i.test(bodyText)
  ) {
    await page.keyboard
      .press("Escape")
      .catch(() => {});

    await page.waitForTimeout(400);
  }
}

/* ============================================================
   PHOTO / VIDEO
============================================================ */

async function findPhotoVideoButton(
  page: Page
): Promise<Locator | null> {
  const dialog =
    await getComposerDialog(page);

  if (!dialog) {
    return null;
  }

  const selectors = [
    '[aria-label*="Photo/video"]',
    '[aria-label*="Photo / video"]',
    '[aria-label*="Ảnh/video"]',
    '[aria-label*="Ảnh / video"]'
  ];

  for (const selector of selectors) {
    const locator =
      dialog
        .locator(selector)
        .last();

    if (
      await locator
        .isVisible()
        .catch(() => false)
    ) {
      return locator;
    }
  }

  const textLocators = [
    dialog.getByText(
      /Photo\/video/i
    ).last(),
    dialog.getByText(
      /Ảnh\/video/i
    ).last()
  ];

  for (const locator of textLocators) {
    if (
      await locator
        .isVisible()
        .catch(() => false)
    ) {
      return locator;
    }
  }

  return null;
}

async function uploadImages(
  page: Page,
  imagePaths: string[]
): Promise<void> {
  if (
    imagePaths.length === 0
  ) {
    throw new Error(
      "Bài này không có ảnh."
    );
  }

  for (
    const imagePath of imagePaths
  ) {
    if (
      !fs.existsSync(imagePath)
    ) {
      throw new Error(
        `Không tìm thấy ảnh:\n${imagePath}`
      );
    }
  }

  console.log(
    `🖼️ Upload ${imagePaths.length} ảnh...`
  );

  const button =
    await findPhotoVideoButton(
      page
    );

  if (!button) {
    throw new Error(
      "Không tìm thấy nút Photo/video."
    );
  }

  /*
   * Bắt filechooser trước khi click.
   */
  const chooserPromise =
    page
      .waitForEvent(
        "filechooser",
        {
          timeout:
            ACTION_TIMEOUT
        }
      )
      .catch(
        () => null
      );

  await button.click({
    timeout:
      ACTION_TIMEOUT
  });

  const chooser =
    await chooserPromise;

  if (chooser) {
    await chooser.setFiles(
      imagePaths
    );

    console.log(
      `✅ Đã gửi ${imagePaths.length} ảnh vào file chooser.`
    );

    await page.waitForTimeout(
      5_000
    );

    return;
  }

  /*
   * Fallback input[type=file].
   */
  await page.waitForTimeout(
    700
  );

  const inputs =
    page.locator(
      'input[type="file"]'
    );

  const inputCount =
    await inputs.count();

  if (inputCount > 0) {
    await inputs
      .last()
      .setInputFiles(
        imagePaths
      );

    console.log(
      `✅ Đã gửi ${imagePaths.length} ảnh qua input[type=file].`
    );

    await page.waitForTimeout(
      5_000
    );

    return;
  }

  throw new Error(
    "Facebook không mở file picker/file input để upload ảnh."
  );
}

/* ============================================================
   POST
============================================================ */

async function findPostButton(
  page: Page
): Promise<Locator | null> {
  const dialog = await getComposerDialog(page);

  if (!dialog) {
    return null;
  }

  /*
   * Facebook's current Page composer uses a blue "Post" button in
   * Post settings. Depending on the rollout/version, that control may
   * be rendered as a <button>, [role=button], or another clickable node.
   * Therefore do NOT rely on one CSS structure.
   */
  const candidates: Locator[] = [
    dialog.getByRole("button", { name: /^Post$/i }).last(),
    dialog.getByRole("button", { name: /^Đăng$/i }).last(),
    dialog.locator('[role="button"]').filter({ hasText: /^Post$/i }).last(),
    dialog.locator('[role="button"]').filter({ hasText: /^Đăng$/i }).last(),
    dialog.getByText(/^Post$/i).last(),
    dialog.getByText(/^Đăng$/i).last(),
    page.getByRole("button", { name: /^Post$/i }).last(),
    page.getByRole("button", { name: /^Đăng$/i }).last(),
    page.locator('[role="button"]').filter({ hasText: /^Post$/i }).last(),
    page.locator('[role="button"]').filter({ hasText: /^Đăng$/i }).last()
  ];

  for (const locator of candidates) {
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }

    if (!(await locator.isEnabled().catch(() => true))) {
      continue;
    }

    const text = await locator.innerText().catch(() => "");
    const aria = await locator.getAttribute("aria-label").catch(() => null);

    if (/^\s*(Post|Đăng)\s*$/i.test(text) || /^\s*(Post|Đăng)\s*$/i.test(aria ?? "")) {
      return locator;
    }
  }

  return null;
}

class PostClickUncertainError extends Error {
  constructor(message: string) {
    super(
      `POST_CLICK_UNCERTAIN: ${message}`
    );
    this.name =
      "PostClickUncertainError";
  }
}

async function findNextButton(
  page: Page
): Promise<Locator | null> {
  const dialog =
    await getComposerDialog(page);

  if (!dialog) {
    return null;
  }

  const selectors = [
    '[aria-label="Next"]',
    '[aria-label="Tiếp"]',
    '[aria-label="Tiếp theo"]',
    'div[role="button"]:has-text("Next")',
    'div[role="button"]:has-text("Tiếp")',
    'button:has-text("Next")',
    'button:has-text("Tiếp")'
  ];

  for (const selector of selectors) {
    const locator =
      dialog
        .locator(selector)
        .last();

    if (
      await locator
        .isVisible()
        .catch(() => false) &&
      await locator
        .isEnabled()
        .catch(() => false)
    ) {
      return locator;
    }
  }

  return null;
}

async function clickNextAfterUpload(
  page: Page
): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const next = await findNextButton(page);
    if (next) {
      console.log("➡️ Ảnh đã upload. Click Next...");
      await next.click({ timeout: ACTION_TIMEOUT });
      await page.waitForTimeout(2_000);
      console.log("✅ Đã click Next.");
      return;
    }
    await page.waitForTimeout(500);
  }

  throw new Error(
    "Không tìm thấy nút Next/Tiếp sau khi upload 4 ảnh."
  );
}


/* ============================================================
   POST
   ============================================================ */

async function publishPost(
  page: Page
): Promise<void> {
  /*
   * IMPORTANT:
   * Customer-chat popup có thể xuất hiện CẢ TRƯỚC lẫn NGAY SAU khi click Post.
   *
   * Trước đây code chỉ xử lý popup trước click Post.
   * Vì vậy sau khi click Post, nếu Facebook bật:
   *   "Chat directly with customers" → "Not now"
   * thì popup phủ lên Post settings và vòng chờ publish không xử lý nó.
   *
   * FIX V9:
   *   1) Đóng popup trước khi click Post.
   *   2) Click Post đúng 1 lần.
   *   3) Trong suốt thời gian Facebook publish, liên tục kiểm tra và
   *      tự click "Not now" nếu customer-chat popup xuất hiện.
   *   4) Sau khi đóng popup, chờ Facebook tiếp tục "Posting".
   *   5) Chỉ kết luận thành công khi composer biến mất.
   *
   * KHÔNG click Post lần thứ hai sau khi click đầu tiên đã được nhận.
   */

  // ------------------------------------------------------------
  // 1. PRE-CLICK: đảm bảo customer-chat popup không che nút Post.
  // ------------------------------------------------------------
  await dismissCustomerChatPopupRepeated(page, 5);

  let button: Locator | null = null;
  const buttonDeadline = Date.now() + 20_000;

  while (Date.now() < buttonDeadline) {
    await dismissCustomerChatPopupRepeated(page, 2);

    button = await findPostButton(page);
    if (button) break;

    await page.waitForTimeout(500);
  }

  if (!button) {
    throw new Error(
      "Không tìm thấy nút Post/Đăng trong composer sau khi upload ảnh."
    );
  }

  // ------------------------------------------------------------
  // 2. CLICK POST — chỉ click đúng 1 lần.
  // ------------------------------------------------------------
  try {
    await dismissCustomerChatPopupRepeated(page, 5);

    // DOM có thể re-render sau khi đóng popup → lấy lại nút Post.
    const freshButton = await findPostButton(page);
    if (freshButton) {
      button = freshButton;
    }

    console.log("🟦 Đã tìm thấy nút Post/Đăng. Đang click...");
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);

    await button.click({
      timeout: ACTION_TIMEOUT,
      force: false
    });

    console.log("✅ Đã gửi click Post. Facebook đang xử lý...");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error);

    throw new PostClickUncertainError(reason);
  }

  // ------------------------------------------------------------
  // 3. AFTER-CLICK:
  //    Popup "Chat directly with customers" có thể xuất hiện ngay
  //    sau click Post. Bắt buộc xử lý "Not now".
  //
  //    Không gọi findPostButton() / click Post lại ở giai đoạn này.
  // ------------------------------------------------------------
  const publishDeadline = Date.now() + 180_000;
  let postingDetected = false;
  let chatPopupHandled = false;

  while (Date.now() < publishDeadline) {
    /*
     * FIX QUAN TRỌNG:
     * Kiểm tra popup sau click Post ở MỖI vòng.
     *
     * Nếu popup xuất hiện:
     *   Chat directly with customers
     *       ↓
     *   Not now
     *
     * dismissCustomerChatPopupRepeated() sẽ click "Not now"
     * và chờ popup biến mất.
     */
    const chatPopupVisible = await page
      .getByText("Chat directly with customers", { exact: true })
      .last()
      .isVisible()
      .catch(() => false);

    if (chatPopupVisible) {
      console.log(
        '⚠️ Customer-chat popup xuất hiện SAU click Post → tự click "Not now"...'
      );

      await dismissCustomerChatPopupRepeated(page, 5);
      chatPopupHandled = true;

      console.log(
        '✅ Đã click "Not now". Tiếp tục chờ Facebook hoàn tất đăng bài.'
      );

      /*
       * Facebook thường re-render Post settings ngay sau khi popup
       * đóng. Cho nó một khoảng ngắn để ổn định trước khi kiểm tra
       * trạng thái Posting.
       */
      await page.waitForTimeout(1_000);
    }

    /*
     * Kiểm tra các dialog trực tiếp.
     * Không gọi getComposerDialog() ở đây vì hàm đó cũng có thể
     * thao tác với popup/re-render DOM trong lúc Facebook publish.
     */
    const dialogs = page.locator('[role="dialog"]');
    const count = await dialogs.count().catch(() => 0);

    let visibleDialogCount = 0;
    let postingNow = false;

    for (let i = count - 1; i >= 0; i--) {
      const dialog = dialogs.nth(i);

      if (!(await dialog.isVisible().catch(() => false))) {
        continue;
      }

      visibleDialogCount++;

      const text = await dialog.innerText().catch(() => "");

      if (/\bPosting\b|Đang đăng/i.test(text)) {
        postingNow = true;
        break;
      }
    }

    if (postingNow) {
      if (!postingDetected) {
        postingDetected = true;
        console.log(
          "⏳ Facebook đã nhận bài và đang Posting... tiếp tục chờ."
        );
      }

      await page.waitForTimeout(1_000);
      continue;
    }

    /*
     * Nếu popup vừa được xử lý và Facebook đang chuyển trạng thái,
     * không coi việc chưa thấy Posting ngay lập tức là lỗi.
     */
    if (chatPopupHandled) {
      chatPopupHandled = false;
      await page.waitForTimeout(1_000);
      continue;
    }

    /*
     * Nếu trước đó đã thấy Posting và bây giờ không còn composer/dialog
     * nữa → publish hoàn tất.
     */
    if (postingDetected && visibleDialogCount === 0) {
      console.log(
        "✅ Facebook đã hoàn tất Posting. Composer đã đóng."
      );
      return;
    }

    /*
     * Facebook có thể đóng composer rất nhanh trước khi chúng ta
     * kịp bắt được chữ Posting.
     */
    if (!postingDetected && visibleDialogCount === 0) {
      console.log("✅ Composer đã đóng sau khi click Post.");
      return;
    }

    /*
     * Facebook có thể có trạng thái loading trung gian không có chữ
     * "Posting". Tiếp tục chờ, tuyệt đối không click Post lần 2.
     */
    await page.waitForTimeout(1_000);
  }

  if (postingDetected) {
    throw new PostClickUncertainError(
      "Facebook đã nhận click Post và đã hiển thị Posting, nhưng sau 3 phút vẫn chưa xác nhận được bài đăng hoàn tất."
    );
  }

  throw new PostClickUncertainError(
    "Đã click Post nhưng sau 3 phút vẫn chưa xác nhận được composer đã đóng."
  );
}
/* ============================================================
   ONE PERSONAL POST
============================================================ */


/* ============================================================
   POST-COMPLETION POPUP: "Maybe later"
   ============================================================ */

async function dismissPostCompletionPopup(page: Page): Promise<void> {
  /*
   * Facebook đôi khi hiện popup sau khi bài đã đăng thành công:
   * "Done! 🎉 Try sharing your photos in a new way"
   * và nút "Maybe later".
   *
   * Đây là popup hậu xử lý, không phải lỗi đăng bài.
   */
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const popupText = page.getByText(
      /Try sharing your photos in a new way/i
    ).last();

    if (!(await popupText.isVisible().catch(() => false))) {
      await page.waitForTimeout(400);
      continue;
    }

    console.log(
      '🎉 Facebook đã đăng xong → popup "Maybe later" xuất hiện.'
    );

    const maybeLater = page
      .getByRole("button", { name: /^Maybe later$/i })
      .last();

    if (await maybeLater.isVisible().catch(() => false)) {
      console.log('➡️ Click "Maybe later"...');

      await maybeLater.scrollIntoViewIfNeeded().catch(() => {});

      try {
        await maybeLater.click({
          timeout: ACTION_TIMEOUT,
          force: true
        });
      } catch {
        await maybeLater
          .evaluate((el) => (el as HTMLElement).click())
          .catch(() => {});
      }

      await page.waitForTimeout(1_000);

      const gone = !(await popupText
        .isVisible()
        .catch(() => false));

      if (gone) {
        console.log('✅ Đã đóng popup bằng "Maybe later".');
        return;
      }
    } else {
      /*
       * Facebook có thể render text trước button.
       * Thử locator theo text chính xác như fallback.
       */
      const fallback = page
        .getByText("Maybe later", { exact: true })
        .last();

      if (await fallback.isVisible().catch(() => false)) {
        console.log('➡️ Click "Maybe later" (fallback)...');

        await fallback.scrollIntoViewIfNeeded().catch(() => {});

        try {
          await fallback.click({
            timeout: ACTION_TIMEOUT,
            force: true
          });
        } catch {
          await fallback
            .evaluate((el) => (el as HTMLElement).click())
            .catch(() => {});
        }

        await page.waitForTimeout(1_000);

        if (!(await popupText
          .isVisible()
          .catch(() => false))) {
          console.log('✅ Đã đóng popup bằng "Maybe later".');
          return;
        }
      }
    }

    await page.waitForTimeout(500);
  }

  /*
   * Không biến một bài đăng thành công thành lỗi chỉ vì popup
   * hậu xử lý không xuất hiện/không đóng được.
   */
  console.log(
    'ℹ️ Không cần xử lý popup "Maybe later" hoặc popup đã tự biến mất.'
  );
}

async function postOne(
  page: Page,
  caption: Caption,
  images: string[],
  postNumber: number
): Promise<void> {
  console.log(
    "\n------------------------------------------"
  );

  console.log(
    `📝 Facebook Page — 1 bài trong lần chạy này`
  );

  console.log(
    `🖼️ ${images.length} ảnh`
  );

  images.forEach(
    (image, index) => {
      console.log(
        `   ${index + 1}. ${path.basename(image)}`
      );
    }
  );

  /*
   * Luôn mở Facebook Page thật.
   */
  await page.goto(
    "https://www.facebook.com/profile.php?id=61568152018103",
    {
      waitUntil:
        "domcontentloaded",
      timeout: 45_000
    }
  );

  await waitForFacebook(
    page
  );

  await page.waitForTimeout(
    2_500
  );

  /*
   * Xác nhận đang đứng đúng Facebook Page trước khi mở composer.
   * Nếu Facebook vẫn đang chuyển trang/re-render thì chờ thêm.
   */
  const targetPageId =
    "61568152018103";

  const pageDeadline =
    Date.now() + 15_000;

  while (Date.now() < pageDeadline) {
    if (
      page.url().includes(
        `id=${targetPageId}`
      )
    ) {
      break;
    }

    await page.waitForTimeout(500);
  }

  if (
    !page.url().includes(
      `id=${targetPageId}`
    )
  ) {
    throw new Error(
      "Facebook chưa ổn định ở đúng Page Đảo Bánh Quy."
    );
  }

  /*
   * Mở composer.
   */
  await dismissCustomerChatPopupRepeated(page);

  await openComposer(
    page
  );

  /*
   * Caption.
   */
  await fillCaption(
    page,
    caption.fullCaption
  );

  /*
   * Đóng popup gợi ý trước khi click Photo/video.
   */
  await dismissComposerSuggestions(
    page
  );

  /*
   * Upload đủ 4 ảnh trong một lần.
   */
  await dismissCustomerChatPopupRepeated(page);

  await uploadImages(
    page,
    images
  );

  await clickNextAfterUpload(page);

  await dismissCustomerChatPopupRepeated(page);

  /*
   * TEST_MODE chỉ dùng khi cần kiểm tra UI.
   */
  if (TEST_MODE) {
    console.log(
      "\n🧪 TEST_MODE = true"
    );

    console.log(
      "⏸️ Đã chuẩn bị bài nhưng KHÔNG click Post."
    );

    await page.pause();

    return;
  }

  /*
   * Chỉ tới đây mới click Post.
   */
  await dismissCustomerChatPopupRepeated(page);

  await publishPost(
    page
  );

  /*
   * Facebook có thể hiện popup "Done! 🎉 Try sharing your photos
   * in a new way" ngay sau khi bài đăng hoàn tất.
   * Popup này phải được đóng bằng "Maybe later" trước khi kết thúc.
   *
   * Đây là bước hậu xử lý, KHÔNG click Post lại.
   */
  await dismissPostCompletionPopup(page);

  console.log(
    "✅ Đã click Post."
  );
}

/* ============================================================
   MAIN
============================================================ */

async function main(): Promise<void> {
  console.log(
    "\n=========================================="
  );

  console.log(`🔧 Version: ${FILE_VERSION}`);

  console.log(
    "       FACEBOOK FACEBOOK PAGE POSTER"
  );

  console.log(
    "==========================================\n"
  );

  const campaignName =
    getCurrentCampaignName();

  const campaign =
    loadCampaign(
      campaignName
    );

  console.log(
    `🎯 Campaign: ${campaign.name}`
  );

  const savedCaptions =
    readJson<SavedCaptions>(
      CAPTIONS_FILE
    );

  if (
    savedCaptions.campaign !==
    campaignName
  ) {
    throw new Error(
      `Campaign hiện tại là "${campaignName}" nhưng captions.json đang thuộc campaign "${savedCaptions.campaign}". ` +
      "Hãy chạy BAT campaign-aware để generate caption mới trước."
    );
  }

  if (
    !Array.isArray(
      savedCaptions.captions
    ) ||
    savedCaptions.captions.length === 0
  ) {
    throw new Error(
      "captions.json không có caption."
    );
  }

  const captions =
    savedCaptions.captions;

  const imagesPerPost = campaign.imageCount ?? 8;

  const randomImages =
    campaign.randomImages ??
    true;

  const allImages =
    getImages(
      campaign.imageFolder
    );

  if (
    allImages.length <
    imagesPerPost
  ) {
    throw new Error(
      `Không đủ ảnh: cần ${imagesPerPost}, có ${allImages.length}.`
    );
  }

  console.log(
    `🖼️ Tổng ảnh: ${allImages.length}`
  );

  console.log(
    `🖼️ Ảnh / bài: ${imagesPerPost}`
  );

  console.log(
    `🔀 Random ảnh: ${randomImages}`
  );

  const state =
    loadState(
      campaignName
    );

  /*
   * Chỉ mở browser một lần.
   * Mỗi lần chạy chỉ đăng một bài.
   */
  const context:
    BrowserContext =
    await chromium.launchPersistentContext(
      PROFILE_DIR,
      {
        headless: false,
        viewport: null,
        args: [
          "--start-maximized"
        ]
      }
    );

  try {
    const pages =
      context.pages();

    const page =
      pages.length > 0
        ? pages[0]
        : await context.newPage();

    /*
     * Check session.
     */
    await page.goto(
      "https://www.facebook.com/profile.php?id=61568152018103",
      {
        waitUntil:
          "domcontentloaded",
        timeout: 45_000
      }
    );

    await waitForFacebook(
      page
    );

    /*
     * Chờ Facebook ổn định đúng Page trước khi bắt đầu thao tác.
     */
    const targetPageId =
      "61568152018103";

    const pageDeadline =
      Date.now() + 15_000;

    while (Date.now() < pageDeadline) {
      if (
        page.url().includes(
          `id=${targetPageId}`
        )
      ) {
        break;
      }

      await page.waitForTimeout(500);
    }

    if (
      !page.url().includes(
        `id=${targetPageId}`
      )
    ) {
      throw new Error(
        "Facebook chưa ổn định ở đúng Page Đảo Bánh Quy."
      );
    }

    const loginDetected =
      await page
        .locator(
          'input[name="email"], input[name="pass"]'
        )
        .first()
        .isVisible()
        .catch(
          () => false
        );

    if (loginDetected) {
      console.log(
        "\n⚠️ Facebook chưa đăng nhập."
      );

      console.log(
        "👉 Đăng nhập bằng tay rồi chạy lại."
      );

      return;
    }

    console.log(
      "✅ Facebook session OK."
    );

    console.log(
      `📅 Hôm nay: ${new Date().toISOString().slice(0, 10)}`
    );
const captionIndex =
      state.nextCaptionIndex % captions.length;

    const caption = captions[captionIndex];

    const selectedImages = randomImages
      ? shuffle(allImages).slice(0, imagesPerPost)
      : allImages.slice(0, imagesPerPost);

    console.log(
      `\n✍️ Caption ${captionIndex + 1}/${captions.length}`
    );
    console.log(
      `🖼️ Facebook Page: chuẩn bị ${imagesPerPost} ảnh cho bài này.`
    );

    await postOne(
      page,
      caption,
      selectedImages,
      1
    );

    state.nextCaptionIndex =
      (captionIndex + 1) % captions.length;
writeJson(
      STATE_FILE,
      state
    );

    console.log(
      "🎉 Đăng bài Facebook Page thành công."
    );

    console.log(
      "\n=========================================="
    );

    console.log(
      "              HOÀN TẤT"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `🎯 Campaign: ${campaign.name}`
    );
console.log(
      "==========================================\n"
    );
  } finally {
    await context.close();
  }
}

main().catch(
  (error) => {
    console.error(
      "\n❌ FATAL ERROR:\n"
    );

    console.error(
      error
    );

    process.exit(1);
  }
);