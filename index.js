// Set up the PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js"

const dom = {
  body: document.body,
  drop: document.getElementById("drop"),
  file: document.getElementById("file"),
  menu: document.getElementById("menu"),
  error: document.getElementById("error"),
  pages: document.getElementById("pages"),
}

const threshold = 0.001

const STATE_ERROR = "has-error"
const STATE_PAGES = "has-pages"

const reader = new FileReader()

const toDataURL = (blob) => {
  reader.abort()

  return new Promise((res) => {
    reader.readAsDataURL(blob)

    reader.onload = (e) => {
      delete reader.onload
      res(e.target.result)
    }
  })
}

const errorRGB = [235, 14, 98]

// TODO: Cancel the running process when adding more files
const handleFiles = (e) => {
  e.preventDefault()
  dom.drop.classList.remove("dragover")

  const files = e.dataTransfer ? e.dataTransfer.files : e.target.files

  if (files.length >= 2) {
    return compareFiles(files[0], files[1])
  }

  dom.body.className = STATE_ERROR
  dom.error.textContent = "Select at least two PDF documents to compare."
}

const createCanvasContext = (width = 1, height = 1, useOffscreen = true) => {
  let canvas

  if (useOffscreen) {
    canvas = new OffscreenCanvas(width, height)
  } else {
    canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
  }

  return canvas.getContext("2d", { willReadFrequently: true })
}

const compareFiles = async (pdfA, pdfB) => {
  try {
    const [docA, docB] = await Promise.all([
      pdfjsLib.getDocument(URL.createObjectURL(pdfA)).promise,
      pdfjsLib.getDocument(URL.createObjectURL(pdfB)).promise,
    ])

    const pageCount = Math.max(docA.numPages, docB.numPages)

    dom.pages.innerHTML = ""
    dom.menu.innerHTML = ""
    dom.error.innerHTML = ""

    for (let i = 1; i <= pageCount; i++) {
      const link = document.createElement("a")
      link.tabIndex = -1
      dom.menu.appendChild(link)
    }

    dom.body.className = STATE_PAGES

    const titleRange = compareTitles(pdfA.name, pdfB.name)

    const ctxA = createCanvasContext()
    const ctxB = createCanvasContext()

    for (let i = 1; i <= pageCount; i++) {
      const [pageA, pageB] = await Promise.all([
        i <= docA.numPages ? docA.getPage(i) : null,
        i <= docB.numPages ? docB.getPage(i) : null,
      ])

      await renderPDFPage(pageA, ctxA)
      await renderPDFPage(pageB, ctxB)

      const diff = comparePages(pageA && ctxA, pageB && ctxB)

      await renderPageComparison(
        i,
        pdfA.name,
        pdfB.name,
        ctxA,
        ctxB,
        diff.ctx,
        diff.score,
        titleRange
      )
    }
  } catch (error) {
    console.error(error)
    dom.body.className = STATE_ERROR
    dom.error.textContent =
      "The documents could not be read. Ensure the PDF files are valid."
  }
}

const compareTitles = (titleA, titleB) => {
  const lenA = titleA.length
  const lenB = titleA.length
  const swap = lenA < lenB

  if (swap) {
    ;[titleB, titleA] = [titleA, titleB]
  }

  let start = 0
  let end = 0

  while (titleA[start] === titleB[start]) start++

  while (titleA.at(end) === titleB.at(end)) end--

  return [start, end + 1]
}

const comparePages = (ctxA, ctxB) => {
  const width = Math.max(
    ctxA ? ctxA.canvas.width : 0,
    ctxB ? ctxB.canvas.width : 0
  )

  const height = Math.max(
    ctxA ? ctxA.canvas.height : 0,
    ctxB ? ctxB.canvas.height : 0
  )

  const ctx = createCanvasContext(width, height)

  if (!ctxA || !ctxB) {
    ctx.rect(0, 0, width, height)
    ctx.fillStyle = `rgb(${errorRGB})`
    ctx.fill()

    return { ctx, score: 1 }
  }

  const dxA = (ctxA.canvas.width - width) * 0.5
  const dyA = (ctxA.canvas.height - height) * 0.5
  const dxB = (ctxB.canvas.width - width) * 0.5
  const dyB = (ctxB.canvas.height - height) * 0.5

  const imgA = ctxA.getImageData(dxA, dyA, width, height)
  const imgB = ctxB.getImageData(dxB, dyB, width, height)

  const diff = ctx.createImageData(width, height)
  const pixelShare = 1 / (width * height)

  let differenceScore = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const R = (y * width + x) * 4
      const G = R + 1
      const B = G + 1
      const A = B + 1

      const a1 = imgA.data[A]
      const a2 = imgB.data[A]

      let k = 1

      if (a1 && a2) {
        const r1 = imgA.data[R]
        const g1 = imgA.data[G]
        const b1 = imgA.data[B]
        const r2 = imgB.data[R]
        const g2 = imgB.data[G]
        const b2 = imgB.data[B]

        const rd = 0.2126 * (Math.abs(r1 - r2) / 255)
        const gd = 0.7152 * (Math.abs(g1 - g2) / 255)
        const bd = 0.0722 * (Math.abs(b1 - b2) / 255)

        k = (rd + gd + bd) ** 0.3
      } else if (!a1 || !a2) {
        k = 0.5
      }

      diff.data[R] = 255 + k * (errorRGB[0] - 255)
      diff.data[G] = 255 + k * (errorRGB[1] - 255)
      diff.data[B] = 255 + k * (errorRGB[2] - 255)
      diff.data[A] = 255

      differenceScore += k
    }
  }

  ctx.putImageData(diff, 0, 0)

  return { ctx, score: differenceScore * pixelShare }
}

const renderPDFPage = async (page, context) => {
  context.clearRect(0, 0, context.canvas.width, context.canvas.height)

  if (!page) return

  const scale = 2
  const viewport = page.getViewport({ scale })

  context.canvas.width = viewport.width
  context.canvas.height = viewport.height

  await page.render({ canvasContext: context, viewport }).promise
}

const renderImage = async (canvas, title, range) => {
  const div = document.createElement("div")
  const h3 = document.createElement("h3")
  const img = document.createElement("img")

  renderPDFTitle(h3, title, range)

  img.width = canvas.width
  img.height = canvas.height

  if (canvas.toDataURL) {
    img.src = canvas.toDataURL()
  } else {
    await canvas
      .convertToBlob()
      .then(toDataURL)
      .then((src) => {
        img.src = src
      })
  }

  div.appendChild(h3)
  div.appendChild(img)
  return div
}

const renderPDFTitle = (element, title, [start, end] = [0, 0]) => {
  if (start > 0) {
    const strong = document.createElement("strong")
    strong.textContent = title.slice(start, end)

    element.append(title.slice(0, start), strong, title.slice(end))
  } else {
    element.textContent = title
  }
}

const renderPageComparison = async (
  pageNumber,
  titleA,
  titleB,
  ctxA,
  ctxB,
  ctxC,
  score,
  titleRange
) => {
  const hasDiff = score > threshold

  const page = document.createElement("li")
  const list = document.createElement("div")
  const header = document.createElement("header")
  const anchor = document.createElement("a")
  const diff = document.createElement("span")

  const id = `page-${pageNumber}`

  page.id = id
  page.className = "page"
  list.className = "list"

  anchor.textContent = `Page ${pageNumber}`
  anchor.href = "#" + id
  anchor.tabIndex = 0

  diff.className = "score"
  diff.textContent = score ? `${(score * 100).toFixed(1)}%` : "No difference"

  header.appendChild(anchor)
  header.appendChild(diff)

  page.classList.toggle("has-diff", hasDiff)

  list.appendChild(await renderImage(ctxA.canvas, titleA, titleRange))
  list.appendChild(await renderImage(ctxB.canvas, titleB, titleRange))
  list.appendChild(await renderImage(ctxC.canvas, "Difference"))

  page.appendChild(header)
  page.appendChild(list)

  dom.pages.appendChild(page)

  const link = dom.menu.children[pageNumber - 1]
  link.href = anchor.href
  link.textContent = pageNumber
  link.classList.toggle("has-diff", hasDiff)
}

dom.drop.addEventListener("click", () => dom.file.click())

dom.drop.addEventListener("dragover", (e) => {
  e.preventDefault()
  dom.drop.classList.add("dragover")
})

dom.drop.addEventListener("dragleave", () => {
  dom.drop.classList.remove("dragover")
})

dom.drop.addEventListener("drop", handleFiles)
dom.file.addEventListener("change", handleFiles)

dom.pages.addEventListener("click", (e) => {
  if (e.target.hash) e.preventDefault()
})

dom.pages.addEventListener("focusin", (e) => {
  if (e.target.hash) document.querySelector(e.target.hash)?.scrollIntoView()
})

window.addEventListener("blur", () => document.activeElement.blur())
