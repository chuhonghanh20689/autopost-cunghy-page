import { chromium, BrowserContext, Locator, Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const FILE_VERSION = "PAGE_POST_V3_NO_STORY_2026-08-23";

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

async function findComposer(
  page: Page
): Promise<Locator | null> {
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

  await page.waitForTimeout(1_500);
}

async function findPostTextbox(
  page: Page
): Promise<Locator | null> {
  const selectors = [
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'div[role="textbox"]',
    "textarea"
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

async function fillCaption(
  page: Page,
  caption: string
): Promise<void> {
  const textbox =
    await findPostTextbox(page);

  if (!textbox) {
    throw new Error(
      "Không tìm thấy ô nhập caption."
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
  const titleCandidates = [
    page
      .getByText(
        "Create post",
        { exact: true }
      )
      .last(),

    page
      .getByText(
        "Tạo bài viết",
        { exact: true }
      )
      .last()
  ];

  for (
    const locator of titleCandidates
  ) {
    if (
      await locator
        .isVisible()
        .catch(() => false)
    ) {
      await locator
        .click()
        .catch(() => {});

      await page.waitForTimeout(600);

      return;
    }
  }

  await page.keyboard
    .press("Escape")
    .catch(() => {});

  await page.waitForTimeout(600);
}

/*
 * Facebook đôi khi hiển thị recommendation thêm nút liên hệ
 * và che composer hoặc bước đăng bài. Chỉ đóng đúng popup này.
 */
async function dismissSpeakWithPeopleDirectlyRecommendation(
  page: Page
): Promise<boolean> {
  const dismissedByDom =
    await page.evaluate(() => {
      const titles = [
        "Speak With People Directly",
        "Chat directly with customers"
      ];

      const titleVisible =
        Array.from(
          document.querySelectorAll<HTMLElement>(
            "h1, h2, h3, h4, div, span"
          )
        ).some((element) =>
          titles.includes(element.textContent?.trim() ?? "") &&
          element.getClientRects().length > 0
        );

      if (!titleVisible) {
        return false;
      }

      const notNow =
        Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, [role="button"]'
          )
        ).find((element) =>
          element.textContent?.trim() === "Not now" &&
          element.getClientRects().length > 0
        );

      if (!notNow) {
        return false;
      }

      notNow.click();

      return true;
    });

  if (dismissedByDom) {
    console.log(
      "💬 Đã đóng gợi ý Chat directly with customers."
    );

    await page.waitForTimeout(600);

    return true;
  }

  const title =
    page
      .getByText(
        /Speak With People Directly|Chat directly with customers/i
      )
      .last();

  if (
    !await title
      .isVisible()
      .catch(() => false)
  ) {
    return false;
  }

  const textButton =
    page
      .getByText(
        "Not now",
        { exact: true }
      )
      .last();

  if (
    await textButton
      .isVisible()
      .catch(() => false)
  ) {
    await textButton.click({
      timeout: ACTION_TIMEOUT
    });

    console.log(
      "💬 Đã đóng gợi ý Chat directly with customers."
    );

    await page.waitForTimeout(600);

    return true;
  }

  const roleButton =
    page
      .locator(
        '[role="button"]:has-text("Not now"), button:has-text("Not now")'
      )
      .last();

  if (
    await roleButton
      .isVisible()
      .catch(() => false)
  ) {
    await roleButton.click({
      timeout: ACTION_TIMEOUT
    });

    console.log(
      "💬 Đã đóng gợi ý Chat directly with customers."
    );

    await page.waitForTimeout(600);

    return true;
  }

  return false;
}

/* ============================================================
   PHOTO / VIDEO
============================================================ */

async function findPhotoVideoButton(
  page: Page
): Promise<Locator | null> {
  const selectors = [
    '[aria-label*="Photo/video"]',
    '[aria-label*="Photo / video"]',
    '[aria-label*="Ảnh/video"]',
    '[aria-label*="Ảnh / video"]'
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

  return await findVisibleText(
    page,
    [
      /Photo\/video/i,
      /Ảnh\/video/i
    ]
  );
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
  const selectors = [
    '[aria-label="Post"]',
    '[aria-label="Đăng"]',
    'div[role="button"]:has-text("Post")',
    'div[role="button"]:has-text("Đăng")'
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
    const locator = page.locator(selector).last();
    if (
      await locator.isVisible().catch(() => false) &&
      await locator.isEnabled().catch(() => true)
    ) {
      return locator;
    }
  }

  return await findVisibleText(page, [
    /^Next$/i,
    /^Tiếp$/i,
    /^Tiếp theo$/i
  ]);
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
  let button: Locator | null = null;
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    button = await findPostButton(page);
    if (button) break;
    await page.waitForTimeout(500);
  }

  if (!button) {
    throw new Error(
      "Không tìm thấy nút Post/Đăng trong composer sau khi upload ảnh."
    );
  }

  try {
    await button.click({
      timeout: ACTION_TIMEOUT
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error);
    throw new PostClickUncertainError(reason);
  }

  await page.waitForTimeout(1_500);

  const closeDeadline = Date.now() + 30_000;

  while (Date.now() < closeDeadline) {
    const recommendationDismissed =
      await dismissSpeakWithPeopleDirectlyRecommendation(
        page
      );

    if (recommendationDismissed) {
      await page.waitForTimeout(1_500);

      return;
    }

    const composer = await findComposer(page);
    if (!composer) return;
    await page.waitForTimeout(750);
  }

  throw new PostClickUncertainError(
    "Đã click Post nhưng không xác nhận được composer đã đóng."
  );
}



/* ============================================================
   ONE PERSONAL POST
============================================================ */

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

  await dismissSpeakWithPeopleDirectlyRecommendation(
    page
  );

  /*
   * Mở composer.
   */
  await openComposer(
    page
  );

  await dismissSpeakWithPeopleDirectlyRecommendation(
    page
  );

  /*
   * Caption.
   */
  await fillCaption(
    page,
    caption.fullCaption
  );

  await dismissSpeakWithPeopleDirectlyRecommendation(
    page
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
  await uploadImages(
    page,
    images
  );

  await clickNextAfterUpload(page);

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
  await publishPost(
    page
  );

  const recommendationDeadline =
    Date.now() + 10_000;

  while (Date.now() < recommendationDeadline) {
    const dismissed =
      await dismissSpeakWithPeopleDirectlyRecommendation(
        page
      );

    if (dismissed) {
      break;
    }

    await page.waitForTimeout(500);
  }

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
      "🖼️ Facebook Page: chọn đúng 4 ảnh cho bài này."
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
    console.log(
      "\n🔒 Đang đóng Facebook browser..."
    );

    await context.close();

    console.log(
      "✅ Đã đóng Facebook browser."
    );
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
