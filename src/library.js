/*
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const { GObject, Gio, GLib, Gtk, Gdk, GdkPixbuf, WebKit2 } = imports.gi
const ByteArray = imports.byteArray
const { Storage, Obj, base64ToPixbuf } = imports.utils
const { Window } = imports.window
const { uriStore } = imports.uriStore

const listBooks = function* (path) {
    const dir = Gio.File.new_for_path(path)
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return
    const children = dir.enumerate_children('standard::name,time::modified',
        Gio.FileQueryInfoFlags.NONE, null)

    let info
    while ((info = children.next_file(null)) != null) {
        try {
            const name = info.get_name()
            const child = dir.get_child(name)
            const [success, data, tag] = child.load_contents(null)
            const json = JSON.parse(data instanceof Uint8Array
                ? ByteArray.toString(data) : data.toString())

            yield {
                identifier: decodeURIComponent(name.replace(/\.json$/, '')),
                metadata: json.metadata,
                progress: json.progress,
                modified: new Date(info.get_attribute_uint64('time::modified') * 1000)
            }
        } catch (e) {
            continue
        }
    }
}

const BookBoxChild =  GObject.registerClass({
    GTypeName: 'FoliateBookBoxChild',
    Properties: {
        entry: GObject.ParamSpec.object('entry', 'entry', 'entry',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, Obj.$gtype),
    }
}, class BookBoxChild extends Gtk.FlowBoxChild {
    _init(params) {
        super._init(params)
        this._image = new Gtk.Image({
            visible: true,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER
        })
        const overlay = new Gtk.Overlay({ visible: true })
        overlay.add(this._image)
        this._grid = new Gtk.Grid({
            visible: true,
            column_homogeneous: true,
            row_homogeneous: true,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER
        })
        overlay.add_overlay(this._grid)
        this.add(overlay)

        const { title } = this.entry.value
        this._image.tooltip_text = title
    }
    loadCover(pixbuf) {
        let width = pixbuf.get_width()
        let height = pixbuf.get_height()
        const maxWidth = 120
        const ratio = maxWidth / width
        if (ratio < 1) {
            width = maxWidth
            height = parseInt(height * ratio, 10)
            this._image.set_from_pixbuf(pixbuf
                .scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR))
        } else this._image.set_from_pixbuf(pixbuf)
        this._image.get_style_context().add_class('foliate-book-image')

        this._grid.width_request = width
        this._grid.height_request = height
        const spine = new Gtk.Box({ visible: true })
        const cover = new Gtk.Box({ visible: true })
        this._grid.attach(spine, 0, 0, 1, 1)
        this._grid.attach(cover, 1, 0, 20, 1)
        spine.get_style_context().add_class('foliate-book-spine')
        cover.get_style_context().add_class('foliate-book-cover')
    }
})

const BookListRow =  GObject.registerClass({
    GTypeName: 'FoliateBookListRow',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/bookListRow.ui',
    InternalChildren: [
        'title', 'creator',
        'progressGrid', 'progressBar', 'progressLabel',
        'remove'
    ],
    Properties: {
        book: GObject.ParamSpec.object('book', 'book', 'book',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, Obj.$gtype),
    }
}, class BookListRow extends Gtk.ListBoxRow {
    _init(params, removeFunc) {
        super._init(params)
        this._removeFunc = removeFunc
        const { progress, metadata: { title, creator } } = this.book.value
        this._title.label = title || ''
        this._creator.label = creator || ''
        if (progress) {
            const fraction = (progress[0] + 1) / (progress[1] + 1)
            this._progressBar.fraction = fraction
            this._progressLabel.label = Math.round(fraction * 100) + '%'
            // this._progressLabel.label = `${(progress[0] + 1)} / ${(progress[1] + 1)}`
            const bookSize = Math.min((progress[1] + 1) / 1500, 0.8)
            const steps = 20
            const span = Math.round(bookSize * steps) + 1
            this._progressGrid.child_set_property(this._progressBar, 'width', span)
            this._progressGrid.child_set_property(this._progressLabel, 'width', steps - span)
            this._progressGrid.child_set_property(this._progressLabel, 'left-attach', span)
        } else this._progressGrid.hide()

        this._remove.connect('clicked', this.remove.bind(this))
    }
    remove() {
        const window = this.get_toplevel()
        const msg = new Gtk.MessageDialog({
            text: _('Are you sure you want to remove this book?'),
            secondary_text: _('Reading progress, annotations, and bookmarks will be permanently lost.'),
            message_type: Gtk.MessageType.WARNING,
            modal: true,
            transient_for: window
        })
        msg.add_button(_('Cancel'), Gtk.ResponseType.CANCEL)
        msg.add_button(_('Remove'), Gtk.ResponseType.ACCEPT)
        msg.set_default_response(Gtk.ResponseType.CANCEL)
        msg.get_widget_for_response(Gtk.ResponseType.ACCEPT)
            .get_style_context().add_class('destructive-action')
        const res = msg.run()
        if (res === Gtk.ResponseType.ACCEPT) {
            const id = this.book.value.metadata.identifier
            this._removeFunc(id)
            uriStore.delete(id)
            Gio.File.new_for_path(Storage.getPath('data', id)).delete(null)
            Gio.File.new_for_path(Storage.getPath('cache', id)).delete(null)
        }
        msg.close()
    }
})

var BookListBox = GObject.registerClass({
    GTypeName: 'FoliateBookListBox'
}, class BookListBox extends Gtk.ListBox {
    _init(params) {
        super._init(params)
        this.set_header_func((row) => {
            if (row.get_index()) row.set_header(new Gtk.Separator())
        })
        this._list = new Gio.ListStore()
        const removeFunc = id => {
            const n = this._list.get_n_items()
            for (let i = 0; i < n; i++) {
                if (this._list.get_item(i).value.metadata.identifier === id) {
                    this._list.remove(i)
                    break
                }
            }
        }
        this.bind_model(this._list, book => new BookListRow({ book }, removeFunc))

        const datadir = GLib.build_filenamev([GLib.get_user_data_dir(), pkg.name])
        const books = listBooks(datadir)
        Array.from(books)
            .filter(x => x.metadata)
            .sort((a, b) => b.modified - a.modified)
            .forEach(x => {
                this._list.append(new Obj(x))
            })

        this.connect('row-activated', (box, row) => {
            const id = row.book.value.metadata.identifier
            const uri = uriStore.get(id)
            if (!uri) {
                const window = this.get_toplevel()
                const msg = new Gtk.MessageDialog({
                    text: _('File location unkown'),
                    secondary_text: _('Choose the location of this file to open it.'),
                    message_type: Gtk.MessageType.QUESTION,
                    buttons: Gtk.ButtonsType.OK_CANCEL,
                    modal: true,
                    transient_for: window
                })
                msg.set_default_response(Gtk.ResponseType.OK)
                const res = msg.run()
                if (res === Gtk.ResponseType.OK)
                    window.application.lookup_action('open').activate(null)
                msg.close()
                return
            }
            const file = Gio.File.new_for_uri(uri)
            this.get_toplevel().open(file)
        })

        const cssProvider = new Gtk.CssProvider()
        cssProvider.load_from_data(`progress, trough { min-width: 1px; }`)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            cssProvider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    }
})

const htmlPath = pkg.pkgdatadir + '/assets/opds.html'
const getCatalog = (uri, handleCover) => {
    const list = new Gio.ListStore()
    const webView = new WebKit2.WebView({
        settings: new WebKit2.Settings({
            enable_write_console_messages_to_stdout: true,
            allow_file_access_from_file_urls: true,
            allow_universal_access_from_file_urls: true,
            enable_developer_extras: true
        })
    })
    const runScript = script => webView.run_javascript(script, null, () => {})

    const contentManager = webView.get_user_content_manager()
    contentManager.connect('script-message-received::action', (_, jsResult) => {
        const data = jsResult.get_js_value().to_string()
        const { type, payload } = JSON.parse(data)
        switch (type) {
            case 'ready':
                runScript(`main("${encodeURI(uri)}")`)
                break
            case 'error':
                print(`Could not retrieve catalog: ${payload}`)
                break
            case 'entry': {
                const entry = new Obj(payload)
                list.append(entry)
                break
            }
            case 'cover': {
                const pixbuf = base64ToPixbuf(payload.base64)
                handleCover(payload.i, pixbuf)
                break
            }
        }
    })
    contentManager.register_script_message_handler('action')

    webView.load_uri(GLib.filename_to_uri(htmlPath, null))
    return list
}

var LibraryWindow =  GObject.registerClass({
    GTypeName: 'FoliateLibraryWindow',
    Template: 'resource:///com/github/johnfactotum/Foliate/ui/libraryWindow.ui',
    InternalChildren: [
        'stack', 'storeBookBox',
    ],
}, class LibraryWindow extends Gtk.ApplicationWindow {
    _init(params) {
        super._init(params)
        this.show_menubar = false
        this.title = _('Foliate')

        this._storeLoaded = false
        this._stack.connect('notify::visible-child-name', () => {
            if (this._stack.visible_child_name === 'store') {
                if (this._storeLoaded) return
                const uri = 'https://standardebooks.org/opds/all'
                const map = new Map()
                const handleCover = (i, pixbuf) => {
                    const child = map.get(i)
                    if (child) child.loadCover(pixbuf)
                }
                const catalog = getCatalog(uri, handleCover)
                this._storeBookBox.bind_model(catalog, entry => {
                    const child = new BookBoxChild({ entry })
                    map.set(entry.value.i, child)
                    return child
                })
                this._storeLoaded = true
            }
        })

        const cssProvider = new Gtk.CssProvider()
        cssProvider.load_from_data(`
            .foliate-book-image {
                box-shadow:
                    5px 5px 5px 2px rgba(0, 0, 0, 0.05),
                    0 0 2px 1px rgba(0, 0, 0, 0.1);
                border: 1px solid rgba(0, 0, 0, 0.25);
                border-radius: 2px;
            }
            .foliate-book-spine {
                box-shadow:
                    inset 11px 0 3px -10px rgba(255, 255, 255, 0.5),
                    inset 10px 0 2px -10px rgba(0, 0, 0, 0.1),
                    inset -10px 0 3px -10px rgba(0, 0, 0, 0.3);
            }
            .foliate-book-cover {
                box-shadow:
                    inset 10px 0 3px -10px rgba(255, 255, 255, 0.7);
            }
        `)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            cssProvider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    }
    open(file) {
        new Window({ application: this.application, file}).present()
        this.close()
    }
})
