import path from 'node:path'
import { promises as fs } from 'node:fs'
import { chromium, devices, type BrowserContext, type Page } from 'playwright'
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib'
import {
  artifactsRoot,
  discoverCoursePages,
  ensureDirectory,
  pdfOutputRoot,
  startStaticServer,
  toAbsoluteSiteUrl,
  type Language
} from './export-site-utils'

type CourseManifestEntry = {
  title: string
  routePath: string
}

type PdfOutlineItem = {
  title: string
  pageIndex: number
}

const PDF_EXPORT_CSS = `
  .VPNav,
  .VPLocalNav,
  .VPSidebar,
  .aside,
  .VPDocFooter,
  .back-to-top-btn,
  .VPNavBarExtra,
  .VPNavBarSocialLinks,
  .VPNavBarAppearance,
  .VPNavBarTranslations,
  .VPSocialLinks,
  .VPDocOutlineDropdown,
  .VPDocAside,
  .VPLocalNavOutlineDropdown {
    display: none !important;
  }

  .Layout,
  .VPContent,
  .VPDoc,
  .VPDoc .container,
  .VPDoc .content,
  .VPDoc .content-container,
  .vp-doc,
  .vp-doc .container {
    max-width: none !important;
    width: auto !important;
    margin: 0 !important;
    padding: 0 !important;
  }

  .VPContent {
    padding-top: 0 !important;
  }

  .vp-doc h1 {
    font-size: 28px !important;
    margin-top: 0 !important;
  }

  .vp-doc h2 {
    page-break-after: avoid;
  }

  pre,
  blockquote,
  table,
  .mermaid,
  .custom-block {
    break-inside: avoid;
  }

  body {
    background: #ffffff !important;
  }
`

async function main() {
  const languages = parseRequestedLanguages(process.argv.slice(2))
  const tempRoot = path.join(artifactsRoot, 'pdfs/.tmp')

  await fs.rm(tempRoot, { recursive: true, force: true })
  await ensureDirectory(tempRoot)
  await ensureDirectory(pdfOutputRoot)

  const server = await startStaticServer()
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext(devices['Desktop Chrome'])

  try {
    for (const language of languages) {
      await buildLanguagePdf(context, server.origin, language, tempRoot)
    }
  } finally {
    await context.close()
    await browser.close()
    await server.close()
  }
}

async function buildLanguagePdf(
  context: BrowserContext,
  origin: string,
  language: Language,
  tempRoot: string
) {
  const pages = await discoverCoursePages(language)
  const tempLanguageDir = path.join(tempRoot, language)
  const outputPdf = path.join(pdfOutputRoot, `learn-harness-engineering-${language}.pdf`)
  const manifestPath = path.join(pdfOutputRoot, `learn-harness-engineering-${language}.json`)

  await fs.rm(tempLanguageDir, { recursive: true, force: true })
  await ensureDirectory(tempLanguageDir)

  const manifest: CourseManifestEntry[] = []
  const tempPdfPaths: string[] = []

  let pageIndex = 1
  for (const entry of pages) {
    const page = await context.newPage()
    const url = toAbsoluteSiteUrl(origin, entry.routePath)

    await page.goto(url, { waitUntil: 'networkidle' })
    await page.addStyleTag({ content: PDF_EXPORT_CSS })
    await page.emulateMedia({ media: 'screen' })

    const title = await extractPageTitle(page, entry.titleHint)
    const safeSlug = entry.routePath
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/[/.]+/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase()

    const tempPdfPath = path.join(
      tempLanguageDir,
      `${String(pageIndex).padStart(2, '0')}-${safeSlug || language}.pdf`
    )

    await page.pdf({
      path: tempPdfPath,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '14mm',
        bottom: '14mm',
        left: '12mm',
        right: '12mm'
      },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font-size:9px;padding:0 12mm;color:#777;display:flex;justify-content:center;"><span class="pageNumber"></span>/<span class="totalPages"></span></div>'
    })

    await page.close()

    manifest.push({ title, routePath: entry.routePath })
    tempPdfPaths.push(tempPdfPath)
    console.log(`Rendered ${language.toUpperCase()} PDF section: ${title}`)
    pageIndex += 1
  }

  const coverPdfPath = path.join(tempLanguageDir, `00-cover-${language}.pdf`)
  await renderCoverPage(context, coverPdfPath, language, manifest.length)

  const coverPageCount = await getPdfPageCount(coverPdfPath)
  const chapterPageCounts = await Promise.all(tempPdfPaths.map(getPdfPageCount))
  const tocPdfPath = path.join(tempLanguageDir, `01-toc-${language}.pdf`)
  const { tocPageCount, sectionStartPages } = await renderTableOfContents(
    context,
    tocPdfPath,
    language,
    manifest,
    coverPageCount,
    chapterPageCounts
  )

  const outlineItems: PdfOutlineItem[] = [
    { title: language === 'zh' ? '封面' : 'Cover', pageIndex: 0 },
    { title: language === 'zh' ? '目录' : 'Contents', pageIndex: coverPageCount },
    ...manifest.map((entry, index) => ({
      title: cleanPdfTitle(entry.title),
      pageIndex: sectionStartPages[index] - 1
    }))
  ]

  await mergePdfs([coverPdfPath, tocPdfPath, ...tempPdfPaths], outputPdf, outlineItems)
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  console.log(
    `Built ${outputPdf} (${coverPageCount} cover page(s), ${tocPageCount} TOC page(s), ${manifest.length} sections, ${outlineItems.length} bookmarks)`
  )
}

async function extractPageTitle(page: Page, fallback: string) {
  const heading = await page.locator('h1').first().textContent().catch(() => null)
  const title = heading?.trim()
  if (title) return title
  const documentTitle = await page.title()
  return documentTitle.split('|')[0].trim() || fallback
}

async function renderCoverPage(
  context: BrowserContext,
  outputPath: string,
  language: Language,
  sectionCount: number
) {
  const page = await context.newPage()
  const generatedAt = new Date().toISOString().slice(0, 10)
  const languageLabel = language === 'en' ? 'English' : '简体中文'
  const sectionLabel = language === 'en' ? 'sections' : '个章节'
  const contentsLabel = language === 'en' ? 'Contents follows this cover' : '目录见下一页'

  await page.setContent(
    `<!doctype html>
      <html lang="${language}">
        <head>
          <meta charset="utf-8" />
          <style>
            body {
              margin: 48px 24px;
              font-family: Georgia, "Times New Roman", serif;
              color: #1a1a1a;
            }
            h1 {
              margin: 0 0 8px;
              font-size: 32px;
            }
            p.meta {
              margin: 0;
              color: #555;
              font-size: 15px;
            }
            .rule {
              width: 72px;
              height: 4px;
              margin: 28px 0;
              background: #1a1a1a;
            }
            p.contents {
              margin: 0;
              color: #333;
              font-size: 16px;
            }
          </style>
        </head>
        <body>
          <h1>Learn Harness Engineering</h1>
          <p class="meta">${languageLabel} coursebook PDF · generated ${generatedAt}</p>
          <div class="rule"></div>
          <p class="contents">${sectionCount} ${sectionLabel} · ${contentsLabel}</p>
        </body>
      </html>`,
    { waitUntil: 'load' }
  )

  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '14mm',
      bottom: '14mm',
      left: '12mm',
      right: '12mm'
    }
  })
  await page.close()
}

async function renderTableOfContents(
  context: BrowserContext,
  outputPath: string,
  language: Language,
  manifest: CourseManifestEntry[],
  coverPageCount: number,
  chapterPageCounts: number[]
) {
  let tocPageCount = 1
  let sectionStartPages: number[] = []

  // Page numbers depend on the TOC length, which in turn can span several pages.
  // Iterate until the rendered TOC page count matches the count used for numbering.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let nextPageNumber = coverPageCount + tocPageCount + 1
    sectionStartPages = chapterPageCounts.map((pageCount) => {
      const startPage = nextPageNumber
      nextPageNumber += pageCount
      return startPage
    })

    await renderTableOfContentsPage(context, outputPath, language, manifest, sectionStartPages)
    const renderedTocPageCount = await getPdfPageCount(outputPath)
    if (renderedTocPageCount === tocPageCount) {
      return { tocPageCount, sectionStartPages }
    }
    tocPageCount = renderedTocPageCount
  }

  throw new Error('Failed to stabilize table of contents page numbering')
}

async function renderTableOfContentsPage(
  context: BrowserContext,
  outputPath: string,
  language: Language,
  manifest: CourseManifestEntry[],
  sectionStartPages: number[]
) {
  const page = await context.newPage()
  const isChinese = language === 'zh'
  const title = isChinese ? '目录' : 'Contents'
  const subtitle = isChinese
    ? 'Learn Harness Engineering · 简体中文'
    : 'Learn Harness Engineering · English'
  const sectionHeading = isChinese ? '章节' : 'Section'
  const pageHeading = isChinese ? 'PDF 页码' : 'PDF page'
  const note = isChinese
    ? '页码为合并后 PDF 的绝对页码；页脚数字仍按各章节内部重新计数。'
    : 'Page numbers refer to the merged PDF. Footer numbers restart within each section.'
  const rows = manifest
    .map(
      (entry, index) => `
        <tr>
          <td class="number">${String(index + 1).padStart(2, '0')}</td>
          <td class="section-title">${escapeHtml(cleanPdfTitle(entry.title))}</td>
          <td class="page-number">${sectionStartPages[index]}</td>
        </tr>`
    )
    .join('')

  await page.setContent(
    `<!doctype html>
      <html lang="${language}">
        <head>
          <meta charset="utf-8" />
          <style>
            @page {
              size: A4;
            }
            * {
              box-sizing: border-box;
            }
            body {
              margin: 0;
              color: #1f2933;
              font-family: "Microsoft YaHei", "Noto Sans CJK SC", "PingFang SC", Arial, sans-serif;
              font-size: 11px;
            }
            h1 {
              margin: 0;
              font-family: Georgia, "Times New Roman", serif;
              font-size: 30px;
              line-height: 1.15;
            }
            .subtitle {
              margin: 7px 0 18px;
              color: #66717d;
              font-size: 13px;
            }
            table {
              width: 100%;
              border-collapse: collapse;
            }
            thead {
              display: table-header-group;
            }
            th {
              padding: 8px 6px;
              border-bottom: 1.5px solid #26323d;
              color: #52606d;
              font-size: 10px;
              font-weight: 600;
              letter-spacing: 0.04em;
              text-align: left;
            }
            th.page-number,
            td.page-number {
              text-align: right;
              white-space: nowrap;
            }
            tbody tr {
              break-inside: avoid;
            }
            tbody tr:nth-child(even) {
              background: #f5f7f9;
            }
            td {
              padding: 6px;
              border-bottom: 1px solid #e4e9ee;
              line-height: 1.35;
              vertical-align: top;
            }
            td.number {
              width: 34px;
              color: #8a96a3;
              font-variant-numeric: tabular-nums;
            }
            td.section-title {
              padding-right: 18px;
            }
            td.page-number {
              width: 68px;
              color: #26323d;
              font-variant-numeric: tabular-nums;
              font-weight: 600;
            }
            .note {
              margin: 14px 0 0;
              padding-top: 9px;
              border-top: 1px solid #d9e0e7;
              color: #7b8794;
              font-size: 10px;
              line-height: 1.45;
            }
          </style>
        </head>
        <body>
          <h1>${title}</h1>
          <p class="subtitle">${subtitle}</p>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>${sectionHeading}</th>
                <th class="page-number">${pageHeading}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="note">${note}</p>
        </body>
      </html>`,
    { waitUntil: 'load' }
  )

  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '14mm',
      bottom: '14mm',
      left: '12mm',
      right: '12mm'
    }
  })
  await page.close()
}

async function getPdfPageCount(inputPath: string) {
  const pdf = await PDFDocument.load(await fs.readFile(inputPath))
  return pdf.getPageCount()
}

async function mergePdfs(
  inputPaths: string[],
  outputPath: string,
  outlineItems: PdfOutlineItem[] = []
) {
  const merged = await PDFDocument.create()

  for (const inputPath of inputPaths) {
    const sourceBytes = await fs.readFile(inputPath)
    const source = await PDFDocument.load(sourceBytes)
    const copiedPages = await merged.copyPages(source, source.getPageIndices())
    for (const copiedPage of copiedPages) {
      merged.addPage(copiedPage)
    }
  }

  if (outlineItems.length > 0) {
    addPdfOutlines(merged, outlineItems)
  }

  await fs.writeFile(outputPath, await merged.save())
}

function addPdfOutlines(pdf: PDFDocument, items: PdfOutlineItem[]) {
  const { context } = pdf
  const outlinesRef = context.nextRef()
  const itemRefs = items.map(() => context.nextRef())

  items.forEach((item, index) => {
    const destination = context.obj([
      pdf.getPage(item.pageIndex).ref,
      PDFName.of('XYZ'),
      null,
      null,
      null
    ])
    const itemDictionary = context.obj({
      Title: PDFHexString.fromText(item.title),
      Parent: outlinesRef,
      Prev: itemRefs[index - 1],
      Next: itemRefs[index + 1],
      Dest: destination
    })
    context.assign(itemRefs[index], itemDictionary)
  })

  context.assign(
    outlinesRef,
    context.obj({
      Type: 'Outlines',
      First: itemRefs[0],
      Last: itemRefs[itemRefs.length - 1],
      Count: itemRefs.length
    })
  )
  pdf.catalog.set(PDFName.of('Outlines'), outlinesRef)
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}

function cleanPdfTitle(value: string) {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseRequestedLanguages(args: string[]): Language[] {
  const languageIndex = args.findIndex((arg) => arg === '--lang')
  if (languageIndex === -1) {
    return ['en', 'zh']
  }

  const value = args[languageIndex + 1]
  if (value === 'en' || value === 'zh') {
    return [value]
  }

  throw new Error(`Unsupported language: ${value}`)
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})