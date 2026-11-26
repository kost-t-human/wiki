// ------------------------------------
// Markdown - Table column widths
// ------------------------------------

/**
 * A `colwidths` attribute as a list with one entry per column: a width in pixels, or null for a
 * column nothing sized.
 *
 * `{colwidths="120,,300"}` under a table, which is how the Visual editor writes the widths a column
 * was dragged to -- markdown has no syntax for one. An entry that is not a positive whole number is a
 * column with no width rather than an error: the value is hand-editable, and a typo in one column
 * should not cost the others theirs.
 *
 * @param {string|null|undefined} value The attribute as written.
 * @returns {Array<number|null>} The widths, empty when there is nothing to read.
 */
export function parseColwidths(value) {
  if (!value) {
    return []
  }
  const widths = String(value)
    .split(',')
    .map((entry) => {
      const width = Number.parseInt(entry.trim(), 10)
      return Number.isInteger(width) && width > 0 ? width : null
    })
  return widths.some((width) => width !== null) ? widths : []
}

/**
 * The widths back as the attribute value: the inverse of `parseColwidths`.
 *
 * @param {Array<number|null|undefined>} widths One entry per column.
 * @returns {string} The value, or an empty string when no column has a width.
 */
export function formatColwidths(widths) {
  if (!widths.some((width) => width > 0)) {
    return ''
  }
  return widths.map((width) => (width > 0 ? String(Math.round(width)) : '')).join(',')
}

/**
 * Lay the table's rows out on a grid, hand each cell the widths of the columns it covers, and say how
 * many columns the table has.
 *
 * The widths go on the cell as `prosemirror-tables` keeps them: a `colwidth` array with one entry per
 * column of its `colspan`. Only the Visual editor reads that (`editor/visual/parse.js`); the page is
 * drawn from the table's own list.
 *
 * MultiMarkdown writes no token for a slot a span covers, so a cell's column is found by skipping the
 * slots rowspans from above have taken rather than by counting cells.
 *
 * @returns {{ columns: number, close: number }} The number of columns, and where the table closes.
 */
function layOutCells(tokens, start, widths) {
  const taken = []
  let row = -1
  let column = 0
  let columns = 0
  let depth = 0
  let close = tokens.length
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === 'table_open') {
      depth++
    } else if (token.type === 'table_close') {
      if (depth === 0) {
        close = i
        break
      }
      depth--
    }
    if (depth > 0) {
      continue
    }
    if (token.type === 'tr_open') {
      row++
      column = 0
    } else if (token.type === 'td_open' || token.type === 'th_open') {
      taken[row] ??= []
      while (taken[row][column]) {
        column++
      }
      const colspan = Math.max(1, Number(token.attrGet('colspan') ?? 1) || 1)
      const rowspan = Math.max(1, Number(token.attrGet('rowspan') ?? 1) || 1)
      const own = widths.slice(column, column + colspan)
      if (own.some((width) => width)) {
        token.meta = {
          ...token.meta,
          colwidth: Array.from({ length: colspan }, (_, n) => own[n] ?? 0)
        }
      }
      for (let r = row; r < row + rowspan; r++) {
        taken[r] ??= []
        for (let c = column; c < column + colspan; c++) {
          taken[r][c] = true
        }
      }
      column += colspan
      columns = Math.max(columns, column)
    }
  }
  return { columns, close }
}

/** Take `colwidths` off a token, and off the inline tokens inside it. */
function dropColwidths(token) {
  if (token.attrs?.some(([name]) => name === 'colwidths')) {
    token.attrs = token.attrs.filter(([name]) => name !== 'colwidths')
  }
  for (const child of token.children ?? []) {
    dropColwidths(child)
  }
}

/**
 * Column widths for tables: `{colwidths="120,,300"}` on the attributes line of a table draws it with
 * a `<colgroup>` of those widths.
 *
 * `markdown-it-attrs` reads the line -- `colwidths` has to be in its `allowedAttributes` -- and puts it
 * on whatever token it addresses. On a table it becomes the `<colgroup>`; on anything else it means
 * nothing and is dropped, so it does not reach the page as an attribute.
 *
 * The list is fitted to the table's columns -- cut short, or filled out with unsized columns -- so a
 * `<col>` is never drawn for a column the table does not have, and the editor writing the list back for
 * the columns it sees does not change the page.
 */
export default (md) => {
  md.core.ruler.after('curly_attributes', 'table_colwidths', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      const value = token.type === 'table_open' ? token.attrGet('colwidths') : null
      dropColwidths(token)
      const widths = parseColwidths(value)
      if (widths.length > 0) {
        const { columns, close } = layOutCells(tokens, i, widths)
        const fitted = Array.from({ length: columns }, (_, n) => widths[n] ?? null)
        if (fitted.some((width) => width)) {
          token.meta = { ...token.meta, colwidths: fitted }
        }
        // -> Every column sized: the table goes in a `.table-sized` wrapper, closed after it
        if (fitted.every((width) => width) && tokens[close]) {
          tokens[close].meta = { ...tokens[close].meta, tableSized: true }
        }
      }
    }
  })

  const renderTableOpen =
    md.renderer.rules.table_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

  /*
    A table with every column sized is drawn at their sum, inside a `.table-sized` wrapper that the
    content stylesheet makes the scrolling box (`_page-contents.scss`), so the widths hold even when they
    add up to more than the article. A table with only some columns sized gets neither: its `<col>`s
    hold their columns and the rest share what is left.
  */
  const renderTableClose =
    md.renderer.rules.table_close ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

  md.renderer.rules.table_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const widths = token.meta?.colwidths
    if (!widths) {
      return renderTableOpen(tokens, idx, options, env, self)
    }
    const sized = widths.every((width) => width)
    if (sized) {
      const total = widths.reduce((sum, width) => sum + width, 0)
      const style = token.attrGet('style')
      token.attrSet(
        'style',
        style ? `${style.replace(/;?\s*$/, ';')} width: ${total}px;` : `width: ${total}px;`
      )
    }
    const cols = widths
      .map((width) => (width ? `<col style="width: ${width}px;">` : '<col>'))
      .join('')
    const table = renderTableOpen(tokens, idx, options, env, self)
    return `${sized ? '<div class="table-sized">\n' : ''}${table}<colgroup>${cols}</colgroup>\n`
  }

  md.renderer.rules.table_close = (tokens, idx, options, env, self) => {
    const table = renderTableClose(tokens, idx, options, env, self)
    return tokens[idx].meta?.tableSized ? `${table}</div>\n` : table
  }
}
