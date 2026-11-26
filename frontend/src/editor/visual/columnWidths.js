import { Plugin } from 'prosemirror-state'
import { TableMap, TableView, columnResizingPluginKey } from 'prosemirror-tables'

/**
 * The width every column of a table is drawn at, measured from its cells.
 *
 * A column some row has a cell of its own in is that cell's width. A column only spans cover gets what
 * is left of a spanning cell once the columns beside it that could be measured are taken off. A cell
 * that already has a `colwidth` is taken at it rather than at its screen width, so a column somebody
 * sized keeps exactly what they gave it.
 */
function measureColumns(view, table, start) {
  const map = TableMap.get(table)
  const widths = []
  const spanning = []
  for (const pos of new Set(map.map)) {
    const rect = map.findCell(pos)
    const cell = table.nodeAt(pos)
    const screen = view.nodeDOM(start + pos)?.offsetWidth || 0
    if (rect.right - rect.left === 1) {
      widths[rect.left] ||= cell.attrs.colwidth?.[0] || screen
    } else {
      spanning.push({ rect, cell, screen })
    }
  }
  for (const { rect, cell, screen } of spanning) {
    const missing = []
    let rest = screen
    for (let col = rect.left; col < rect.right; col++) {
      const own = cell.attrs.colwidth?.[col - rect.left]
      if (own && !widths[col]) {
        widths[col] = own
      }
      if (widths[col]) {
        rest -= widths[col]
      } else {
        missing.push(col)
      }
    }
    for (const col of missing) {
      widths[col] = Math.max(DEFAULT_CELL_MIN_WIDTH, Math.round(rest / missing.length))
    }
  }
  return Array.from({ length: map.width }, (_, col) => widths[col] || 0)
}

/**
 * Give every column of a table a width when one of its edges is dragged, so that only the dragged
 * column moves.
 *
 * `columnResizing` sets the width of the dragged column and nothing else, and leaves a column nobody
 * sized without one. It relies on `table-layout: fixed` from its own stylesheet to hold such columns in
 * place, but a table here is laid out automatically until every column has a width (see `WikiTableView`
 * below), and under automatic layout the room the dragged column gives up or takes goes to the columns
 * without one -- in a table of two, shrinking the first column widened the second and the first did not
 * shrink at all.
 *
 * So the widths the columns are drawn at are measured when an edge is grabbed, and:
 *
 * - while the edge is dragged, the colgroup `columnResizing` redraws on every move is given them for the
 *   columns it leaves empty, and the table their sum, which is what holds the other columns still;
 * - when it is let go, they go into the document in a transaction appended to the one `columnResizing`
 *   writes the dragged width with, so the whole resize is one step to undo and one change to a
 *   collaborator.
 *
 * A press let go within a few pixels of where it was grabbed writes nothing at all -- `columnResizing` would otherwise
 * store the clicked column's width, and clicking near a cell's edge to put the caret there is common.
 * Any other change to the document while an edge is held is left alone; only the release writes. A
 * collaborator's edit arriving mid-drag replaces the whole document (y-prosemirror) and takes the handle
 * away under `columnResizing`, which then threw on every move until the page was reloaded; the drag is
 * dropped instead.
 *
 * Before `columnResizing` in the plugin list, so that its `mousedown` sees the handle before
 * `columnResizing` starts the drag.
 */
/** How far, in pixels, an edge has to be let go from where it was grabbed to count as a drag. */
const CLICK_SLOP = 3

export function freezeColumnWidths() {
  let session = null

  const end = () => {
    session?.stop()
    session = null
  }

  return new Plugin({
    view: () => ({ destroy: end }),
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          const resize = columnResizingPluginKey.getState(view.state)
          if (!view.editable || !resize || resize.activeHandle === -1 || resize.dragging) {
            return false
          }
          end()
          const $cell = view.state.doc.resolve(resize.activeHandle)
          const start = $cell.start(-1)
          const wrapper = view.nodeDOM(start - 1)
          const tableDom = wrapper?.querySelector(':scope > table')
          if (!tableDom) {
            return false
          }
          const widths = measureColumns(view, $cell.node(-1), start)
          const win = view.dom.ownerDocument.defaultView ?? window
          const startX = event.clientX

          /*
            The release, told apart from any other change to the document a drag can coincide with. Added
            here, before `columnResizing` adds its own listeners, so it runs first: by the time its
            `finish` writes the dragged width, the session already knows that is the release. Its `move`
            also finishes on a move with no button held, which is a release this page never saw.
          */
          const onRelease = (releaseEvent) => {
            if (session) {
              session.released = true
              // -> Where it was let go, not how it got there: a few pixels of jitter is a click
              session.moved = Math.abs(releaseEvent.clientX - startX) >= CLICK_SLOP
            }
          }
          const onRawMove = (moveEvent) => {
            if (!moveEvent.which) {
              onRelease(moveEvent)
            }
          }

          /*
            The columns nobody sized are given what they were measured at, and the table their sum,
            each time `columnResizing` redraws the colgroup -- which it does on every move and once
            already on the press itself, before any move, with those columns left empty. Left that way
            for even a frame the table is laid out automatically and the columns jump and come back.
          */
          const hold = () => {
            let total = 0
            tableDom.querySelectorAll(':scope > colgroup > col').forEach((col, i) => {
              if (!col.style.width && widths[i]) {
                col.style.width = `${widths[i]}px`
              }
              total += Number.parseFloat(col.style.width) || 0
            })
            tableDom.style.width = `${total}px`
            tableDom.style.minWidth = ''
            wrapper.classList.add('table-sized')
          }
          // -> After `columnResizing` has redrawn the colgroup for this move: its listener is added when
          //    its own `mousedown` runs, which is after this one, so this one goes on a microtask
          const onMove = () => {
            if (!session) {
              return
            }
            // -> `columnResizing` is done with the drag, whether or not it wrote anything
            if (!columnResizingPluginKey.getState(view.state)?.dragging) {
              end()
              return
            }
            hold()
          }

          session = {
            widths,
            moved: false,
            released: false,
            stop() {
              win.removeEventListener('mouseup', onRelease)
              win.removeEventListener('mousemove', onRawMove)
              win.removeEventListener('mousemove', onMove)
              win.removeEventListener('mouseup', end)
            }
          }
          win.addEventListener('mouseup', onRelease)
          win.addEventListener('mousemove', onRawMove)
          queueMicrotask(() => {
            if (session) {
              win.addEventListener('mousemove', onMove)
              win.addEventListener('mouseup', end)
              if (columnResizingPluginKey.getState(view.state)?.dragging) {
                hold()
              } else {
                // -> `columnResizing` did not start a drag on this press
                end()
              }
            }
          })
          return false
        }
      }
    },

    // -> A click, not a drag: drop the width `columnResizing` writes on release
    filterTransaction(tr, state) {
      return !(
        session?.released &&
        !session.moved &&
        tr.docChanged &&
        columnResizingPluginKey.getState(state)?.dragging
      )
    },

    appendTransaction(transactions, _oldState, newState) {
      if (!session) {
        return null
      }
      const resize = columnResizingPluginKey.getState(newState)
      // -> The handle mapped away under a drag: somebody else's edit replaced the document
      if (resize?.dragging && resize.activeHandle === -1) {
        end()
        return newState.tr.setMeta(columnResizingPluginKey, { setHandle: -1 })
      }
      if (
        !session.released ||
        !session.moved ||
        !resize?.dragging ||
        !transactions.some((tr) => tr.docChanged)
      ) {
        return null
      }

      // -> `columnResizing` writing the dragged width, on release. The table is found from its handle,
      //    which it maps through every change, rather than from where the table was when it was grabbed
      const { widths } = session
      end()
      const $cell = newState.doc.resolve(resize.activeHandle)
      const table = $cell.node(-1)
      const start = $cell.start(-1)
      const map = TableMap.get(table)
      if (map.width !== widths.length) {
        return null
      }
      const tr = newState.tr
      for (const pos of new Set(map.map)) {
        const cell = table.nodeAt(pos)
        const rect = map.findCell(pos)
        const current = cell.attrs.colwidth ?? []
        const filled = []
        for (let col = rect.left; col < rect.right; col++) {
          filled.push(current[col - rect.left] || widths[col] || 0)
        }
        if (filled.some((width, i) => width !== (current[i] || 0))) {
          tr.setNodeMarkup(start + pos, null, { ...cell.attrs, colwidth: filled })
        }
      }
      return tr.docChanged ? tr : null
    }
  })
}

/**
 * The smallest width a column nobody sized is laid out at, in pixels: the `3rem` that
 * `_visual-editor.scss` gives `--default-cell-min-width`. `columnResizing` writes its own value of that
 * property onto every table, 100px unless told otherwise, which made every table in the editor wider
 * than the page draws it.
 */
export const DEFAULT_CELL_MIN_WIDTH = 48

/**
 * The table as `columnResizing` draws it -- `div.tableWrapper > table > colgroup + tbody` -- plus the
 * two things this editor needs from it.
 *
 * - The table's own `{#id .class}`: the view replaces the schema's `toDOM`, so without this a table's
 *   classes were not drawn while it was edited, although the page draws them.
 * - `table-sized` on the wrapper once every column has a width. The content stylesheet then makes the
 *   wrapper the scrolling box and lays the table out at exactly those widths (`_page-contents.scss`,
 *   the same class the page renderer puts round such a table). Without it the table is the scrolling
 *   box itself and the real table inside it is squeezed to the article's width, so a column dragged
 *   past the edge took its width from its neighbours instead of scrolling.
 */
export class WikiTableView extends TableView {
  constructor(node, defaultCellMinWidth) {
    super(node, defaultCellMinWidth)
    this.drawAttrs()
  }

  update(node) {
    if (!super.update(node)) {
      return false
    }
    this.drawAttrs()
    return true
  }

  drawAttrs() {
    const { id, class: className } = this.node.attrs.mdAttrs ?? {}
    if (id) {
      this.table.id = id
    } else {
      this.table.removeAttribute('id')
    }
    this.table.className = className ?? ''
    // -> `updateColumnsOnResize` gives the table a `width` exactly when every column has one
    this.dom.classList.toggle('table-sized', Boolean(this.table.style.width))
  }

  ignoreMutation(record) {
    return (
      (record.type === 'attributes' && record.target === this.dom) || super.ignoreMutation(record)
    )
  }
}
