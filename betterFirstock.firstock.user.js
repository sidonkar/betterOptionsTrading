// ==UserScript==
// @name         betterFirstock
// @namespace    https://github.com/amit0rana/betterKite
// @version      5.01-firstock.1
// @description  Firstock host adapter for betterFirstock utilities
// @author       Amit with inputs from bsvinay, sidonkar, rbcdev
// @match        https://app.firstock.in/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_getClipboard
// @grant        unsafeWindow
// @require      https://ajax.googleapis.com/ajax/libs/jquery/3.4.1/jquery.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/axios/0.21.1/axios.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.27.0/moment.min.js
// @require      https://unpkg.com/sweetalert2@11
// @require      https://cdn.jsdelivr.net/npm/toastify-js
// @resource     TOASTIFY_CSS https://cdn.jsdelivr.net/npm/toastify-js/src/toastify.min.css
// ==/UserScript==

(function () {
    'use strict';

    const HOST = window.location.host;
    const PATH = window.location.pathname;
    const ORIGIN = window.location.origin;

    const isFirstock = HOST === 'app.firstock.in' || HOST.endsWith('.firstock.in');

    if (!isFirstock) {
        return;
    }

    const toastCss = typeof GM_getResourceText === 'function' ? GM_getResourceText('TOASTIFY_CSS') : '';
    if (toastCss && typeof GM_addStyle === 'function') {
        GM_addStyle(toastCss);
    }

    const $ = window.jQuery || window.$;
    const api = {
        origin: ORIGIN,
        host: HOST,
        path: PATH,
    };

    const state = {
        initialized: false,
        initAttempts: 0,
        lastRoute: PATH,
        positionsEnhancerTimer: null,
        positionsObserver: null,
        backgroundRefreshTimer: null,
        titleObserver: null,
        titleMutationScheduled: false,
        titleLockInstalled: false,
        titleLockActive: false,
        titleWriteBypass: false,
        lastPositionsStatus: 'idle',
        lastPositionsMeta: null,
        defaultDocumentTitle: document.title,
        lastRenderedGroups: [],
        currentCustomTitle: '',
    };
    const pageBridge = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    function debug(...args) {
        console.log('[betterFirstock:firstock]', ...args);
    }

    function showToast(message, background = '#1f2937') {
        if (typeof Toastify === 'function') {
            Toastify({
                text: message,
                duration: 3000,
                gravity: 'top',
                position: 'right',
                close: true,
                style: { background },
            }).showToast();
            return;
        }
        console.log(message);
    }

    function addStyle(cssText) {
        if (!cssText || typeof GM_addStyle !== 'function') {
            return;
        }
        GM_addStyle(cssText);
    }

    function waitForElement(selector, callback, timeoutMs = 30000) {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            const element = document.querySelector(selector);
            if (element) {
                clearInterval(timer);
                callback(element);
                return;
            }
            if (Date.now() - startedAt > timeoutMs) {
                clearInterval(timer);
            }
        }, 250);
        return timer;
    }

    function ensureBadge() {
        const existing = document.getElementById('betterfirstock-badge');
        if (existing) {
            return existing;
        }

        const badge = document.createElement('div');
        badge.id = 'betterfirstock-badge';
        badge.textContent = 'betterFirstock loaded';
        badge.style.cssText = [
            'position:fixed',
            'right:12px',
            'bottom:12px',
            'z-index:2147483647',
            'padding:8px 10px',
            'border-radius:999px',
            'font:12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
            'background:#111827',
            'color:#fff',
            'box-shadow:0 6px 18px rgba(0,0,0,.25)',
            'cursor:default',
            'user-select:none',
        ].join(';');
        document.body.appendChild(badge);
        return badge;
    }

    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') {
            return;
        }

        GM_registerMenuCommand('betterFirstock: show status', () => {
            showToast(`Loaded on ${api.host}${api.path}`);
        });
    }

    function routeChanged() {
        const currentPath = window.location.pathname;
        const previousPath = state.lastRoute;
        if (currentPath === previousPath) {
            return;
        }
        state.lastRoute = currentPath;
        debug('route changed', currentPath);
        if (previousPath === '/positions' || currentPath === '/positions') {
            schedulePositionsEnhancer();
        }
    }

    function isPositionsPage() {
        return window.location.pathname === '/positions';
    }

    function parseMoney(value) {
        if (!value) {
            return 0;
        }
        const normalized = String(value)
            .replace(/,/g, '')
            .replace(/[^\d.+-]/g, '');
        const parsed = Number.parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function formatMoney(value) {
        const sign = value < 0 ? '-' : '';
        const absoluteValue = Math.abs(value);
        return `${sign}\u20b9${absoluteValue.toLocaleString('en-IN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })}`;
    }

    function formatCompactMoney(value) {
        const sign = value < 0 ? '-' : '';
        const absoluteValue = Math.abs(value);

        if (absoluteValue >= 100000) {
            return `${sign}\u20b9${(absoluteValue / 100000).toFixed(1)}L`;
        }

        if (absoluteValue >= 1000) {
            return `${sign}\u20b9${(absoluteValue / 1000).toFixed(1)}k`;
        }

        if (absoluteValue >= 100) {
            return `${sign}\u20b9${absoluteValue.toFixed(0)}`;
        }

        return `${sign}\u20b9${absoluteValue.toFixed(1)}`;
    }

    function updateDocumentTitle(groups = []) {
        state.lastRenderedGroups = groups;

        if (!isPositionsPage()) {
            state.currentCustomTitle = '';
            state.titleLockActive = false;
            setDocumentTitle(state.defaultDocumentTitle);
            return;
        }

        if (!groups.length) {
            state.currentCustomTitle = '';
            state.titleLockActive = false;
            setDocumentTitle(state.defaultDocumentTitle);
            return;
        }

        const compactExpiry = (expiryText) => {
            const expiry = String(expiryText || '').trim().toUpperCase();
            const datedMatch = expiry.match(/^(\d{1,2})(?:ST|ND|RD|TH)\s+([A-Z]{3})$/);
            if (datedMatch) {
                const day = datedMatch[1];
                const month = datedMatch[2].charAt(0) + datedMatch[2].slice(1).toLowerCase();
                return `${day}${month}`;
            }

            const monthOnlyMatch = expiry.match(/^([A-Z]{3})$/);
            if (monthOnlyMatch) {
                return monthOnlyMatch[1].charAt(0) + monthOnlyMatch[1].slice(1).toLowerCase();
            }

            return expiryText;
        };

        const summary = groups
            .map((group) => {
                const parts = group.label.split(' ');
                const underlying = parts[0] || '';
                const expiry = parts.slice(1).join(' ');
                const underlyingShort = ({
                    SENSEX: 'S',
                    NIFTY: 'N',
                })[underlying] || underlying;
                const compactLabel = expiry ? `${underlyingShort} ${compactExpiry(expiry)}` : underlyingShort;
                return `${compactLabel} ${formatCompactMoney(group.totalPnl)}`;
            })
            .join(' | ');

        state.currentCustomTitle = summary;
        state.titleLockActive = true;
        setDocumentTitle(summary);
    }

    function setDocumentTitle(value) {
        state.titleWriteBypass = true;
        document.title = value;
        state.titleWriteBypass = false;
    }

    function installTitleLock() {
        if (state.titleLockInstalled) {
            return;
        }

        const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'title')
            || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'title');

        if (!descriptor || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') {
            return;
        }

        Object.defineProperty(document, 'title', {
            configurable: true,
            enumerable: descriptor.enumerable ?? true,
            get() {
                return descriptor.get.call(document);
            },
            set(value) {
                if (state.titleWriteBypass) {
                    descriptor.set.call(document, value);
                    return;
                }

                if (isPositionsPage() && state.titleLockActive && state.currentCustomTitle) {
                    if (descriptor.get.call(document) !== state.currentCustomTitle) {
                        descriptor.set.call(document, state.currentCustomTitle);
                    }
                    return;
                }

                descriptor.set.call(document, value);
            },
        });

        state.titleLockInstalled = true;
    }

    function ensureTitleObserver() {
        if (state.titleObserver) {
            return;
        }

        const titleElement = document.querySelector('title');
        if (!titleElement) {
            return;
        }

        state.titleObserver = new MutationObserver(() => {
            if (state.titleMutationScheduled) {
                return;
            }

            state.titleMutationScheduled = true;
            window.setTimeout(() => {
                state.titleMutationScheduled = false;

                if (!isPositionsPage()) {
                    state.defaultDocumentTitle = document.title || state.defaultDocumentTitle;
                    state.currentCustomTitle = '';
                    state.titleLockActive = false;
                    return;
                }

                if (state.lastRenderedGroups.length) {
                    const desiredTitle = state.currentCustomTitle;
                    if (desiredTitle && document.title !== desiredTitle) {
                        setDocumentTitle(desiredTitle);
                    }
                }
            }, 50);
        });

        state.titleObserver.observe(titleElement, {
            childList: true,
            characterData: true,
            subtree: true,
        });
    }

    function getMonthToken(token) {
        return /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/i.test(token || '');
    }

    function extractExpiryFromParts(parts, isIndexDerivative) {
        const normalizedParts = (parts || []).map((part) => String(part || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (!normalizedParts.length) {
            return 'UNKNOWN EXPIRY';
        }

        for (let i = 0; i < normalizedParts.length; i += 1) {
            const current = normalizedParts[i];
            const next = normalizedParts[i + 1] || '';

            if (/^\d{1,2}(st|nd|rd|th)$/i.test(current) && getMonthToken(next)) {
                return isIndexDerivative ? next.toUpperCase() : `${current.toUpperCase()} ${next.toUpperCase()}`;
            }
        }

        const monthToken = normalizedParts.find((part) => getMonthToken(part));
        if (monthToken) {
            return monthToken.toUpperCase();
        }

        const embeddedMonth = normalizedParts.find((part) => /^\d{1,2}[A-Z]{3}$/i.test(part));
        if (embeddedMonth) {
            return isIndexDerivative ? embeddedMonth.replace(/^\d{1,2}/, '').toUpperCase() : embeddedMonth.toUpperCase();
        }

        return 'UNKNOWN EXPIRY';
    }

    function getExpirySortValue(expiryLabel) {
        const normalized = String(expiryLabel || '').replace(/\s+/g, ' ').trim().toUpperCase();
        if (!normalized || normalized === 'UNKNOWN EXPIRY') {
            return Number.POSITIVE_INFINITY;
        }

        const monthOrder = {
            JAN: 1,
            FEB: 2,
            MAR: 3,
            APR: 4,
            MAY: 5,
            JUN: 6,
            JUL: 7,
            AUG: 8,
            SEP: 9,
            OCT: 10,
            NOV: 11,
            DEC: 12,
        };

        const match = normalized.match(/^(\d{1,2})(?:ST|ND|RD|TH)?\s+([A-Z]{3})$/);
        if (match) {
            const day = Number.parseInt(match[1], 10);
            const month = monthOrder[match[2]] || 99;
            return month * 100 + day;
        }

        const monthOnly = normalized.match(/^([A-Z]{3})$/);
        if (monthOnly) {
            const month = monthOrder[monthOnly[1]] || 99;
            return month * 100 + 99;
        }

        return 10000 + normalized.charCodeAt(0);
    }

    function parseInstrumentGroup(instrument) {
        const cleaned = String(instrument || '').replace(/\s+/g, ' ').trim();
        const parts = cleaned.split(' ').filter(Boolean);
        const market = (parts[parts.length - 1] || '').toUpperCase();
        const hasDerivativePattern = /\b(FUT|CE|PE)\b/i.test(cleaned);
        const indexUnderlyings = new Set([
            'NIFTY',
            'BANKNIFTY',
            'FINNIFTY',
            'SENSEX',
            'BANKEX',
            'MIDCPNIFTY',
        ]);
        const underlying = parts[0] || 'UNKNOWN';
        const isIndexUnderlying = indexUnderlyings.has(underlying.toUpperCase());
        const looksLikeIndexDerivative = isIndexUnderlying && parts.length > 1;
        const isDerivative = market === 'NFO' || market === 'BFO' || hasDerivativePattern || looksLikeIndexDerivative;

        if (!isDerivative) {
            return {
                market: market || 'OTHER',
                underlying: 'EQUITY',
                expiry: '',
                label: 'Equity',
                key: 'EQUITY',
                basketLabel: 'Equity',
                basketKey: 'EQUITY',
                assetClass: 'EQUITY',
            };
        }

        const isIndexDerivative = isIndexUnderlying;

        const coreParts = market === 'NFO' || market === 'BFO' ? parts.slice(0, -1) : parts.slice();
        const expiry = extractExpiryFromParts(coreParts, isIndexDerivative);
        const expiryLabel = extractExpiryFromParts(coreParts, false);

        const basketLabel = isIndexDerivative ? `${underlying.toUpperCase()} ${expiry}` : underlying.toUpperCase();
        const basketKey = isIndexDerivative ? `${underlying.toUpperCase()}__${expiry}` : underlying.toUpperCase();

        return {
            market,
            underlying: underlying.toUpperCase(),
            expiry,
            expiryLabel,
            label: `${underlying.toUpperCase()} ${expiry}`,
            key: `${underlying.toUpperCase()}__${expiry}`,
            basketLabel,
            basketKey,
            basketOrder: isIndexDerivative ? 1 : 0,
            assetClass: 'DERIVATIVE',
        };
    }

    function extractInstrumentName(text) {
        const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) {
            return '';
        }

        const parts = cleaned.split(' ').filter(Boolean);
        if (!parts.length) {
            return '';
        }

        const lastWord = parts[parts.length - 1].toUpperCase();
        if (lastWord === 'NFO' || lastWord === 'BFO' || lastWord === 'EQUITY') {
            return parts.slice(0, -1).join(' ');
        }

        return cleaned;
    }

    function findPositionsTable() {
        const openPositionsHeading = Array.from(document.querySelectorAll('h1, h2, h3, h4, div, span')).find((node) => {
            if (isInsideBetterFirstockSummary(node)) {
                return false;
            }
            const text = node.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() || '';
            return text.startsWith('open positions');
        });

        if (openPositionsHeading) {
            const scopedContainer = openPositionsHeading.closest('section, div');
            const scopedTables = Array.from(scopedContainer?.querySelectorAll('table') || []).filter((table) => !isInsideBetterFirstockSummary(table));
            const scopedMatch = scopedTables.find((table) => {
                const headerText = table.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() || '';
                return headerText.includes('instrument') && headerText.includes('p&l');
            });
            if (scopedMatch) {
                return scopedMatch;
            }
        }

        const tables = Array.from(document.querySelectorAll('table')).filter((table) => !isInsideBetterFirstockSummary(table));
        return tables.find((table) => {
            const headerCells = Array.from(table.querySelectorAll('thead th, tr th')).map((cell) =>
                cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase()
            );
            const headerBlob = headerCells.join(' ');
            return (
                (headerCells.includes('instrument') || headerBlob.includes('instrument')) &&
                ((headerCells.includes('p&l') || headerBlob.includes('p&l')) || headerBlob.includes('p l'))
            );
        }) || null;
    }

    function findOpenPositionsContainer() {
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, div, span')).filter((node) => {
            if (isInsideBetterFirstockSummary(node)) {
                return false;
            }
            const text = getNormalizedText(node).toLowerCase();
            return /^open positions(?:\s*\(\d+\))?$/.test(text);
        });

        for (const heading of headings) {
            const container = heading.closest('section, div');
            if (!container) {
                continue;
            }

            const expanded = container.parentElement?.closest('section, div') || container.parentElement || container;
            const text = getNormalizedText(expanded).toLowerCase();
            if (
                text.includes('instrument') &&
                text.includes('qty') &&
                text.includes('price') &&
                text.includes('ltp') &&
                text.includes('p&l')
            ) {
                return expanded;
            }
        }

        const candidates = Array.from(document.querySelectorAll('section, div')).filter((node) => !isInsideBetterFirstockSummary(node));
        return candidates.find((node) => {
            const text = getNormalizedText(node).toLowerCase();
            return (
                text.includes('open positions') &&
                text.includes('instrument') &&
                text.includes('qty') &&
                text.includes('price') &&
                text.includes('ltp') &&
                text.includes('p&l')
            );
        }) || null;
    }

    function getExpectedOpenPositionsCount() {
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, div, span'));
        for (const node of headings) {
            const text = getNormalizedText(node);
            const match = text.match(/^Open positions\s*\((\d+)\)$/i);
            if (match) {
                return Number.parseInt(match[1], 10);
            }
        }
        return null;
    }

    function getNormalizedText(node) {
        return node?.textContent?.replace(/\s+/g, ' ').trim() || '';
    }

    function isInsideBetterFirstockSummary(node) {
        return Boolean(node?.closest?.('#betterfirstock-positions-summary'));
    }

    function looksLikeHeaderText(text) {
        const normalized = text.toLowerCase();
        return (
            normalized.includes('instrument') &&
            normalized.includes('qty') &&
            normalized.includes('price') &&
            normalized.includes('ltp') &&
            (normalized.includes('p&l') || normalized.includes('p& l') || normalized.includes('p & l'))
        );
    }

    function looksLikeInstrumentText(text) {
        const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) {
            return false;
        }

        const lower = cleaned.toLowerCase();
        if (
            lower.includes('qty') ||
            lower.includes('price') ||
            lower.includes('ltp') ||
            lower.includes('p&l') ||
            lower.includes('product type') ||
            lower.includes('cf qty') ||
            lower.includes('realised') ||
            lower.includes('unrealised') ||
            lower.includes('invested value') ||
            lower.includes('placed by') ||
            lower.includes('mtm')
        ) {
            return false;
        }

        return /^[A-Z][A-Z0-9&.-]*(?:\s+[A-Z0-9&.-]+){0,5}$/i.test(cleaned);
    }

    function isLikelyPositionRow(node) {
        if (!node || node.children.length < 4) {
            return false;
        }
        const text = getNormalizedText(node);
        if (!text || looksLikeHeaderText(text) || text.toLowerCase().includes('total p&l')) {
            return false;
        }

        const childTexts = Array.from(node.children).map((child) => getNormalizedText(child)).filter(Boolean);
        if (childTexts.length < 4) {
            return false;
        }

        const instrumentSource = childTexts[0] || childTexts[1] || '';
        if (!looksLikeInstrumentText(instrumentSource)) {
            return false;
        }

        const firstCellInstrument =
            extractInstrumentFromText(childTexts[0] || '') ||
            extractInstrumentName(childTexts[0] || '') ||
            extractInstrumentFromText(childTexts[1] || '') ||
            extractInstrumentName(childTexts[1] || '');
        if (!firstCellInstrument) {
            return false;
        }

        const numericLikeCount = childTexts.filter((value) => /[-+]?[\d,]+(?:\.\d+)?/.test(value)).length;
        return numericLikeCount >= 4;
    }

    function filterLeafPositionRows(rows) {
        return rows.filter((row) => !rows.some((other) => other !== row && row.contains(other)));
    }

    function findPositionsGridRows(container) {
        if (!container) {
            return [];
        }

        const allNodes = Array.from(container.querySelectorAll('div, section, article')).filter((node) => !isInsideBetterFirstockSummary(node));
        const headerNode = allNodes.find((node) => looksLikeHeaderText(getNormalizedText(node)));
        if (!headerNode || !headerNode.parentElement) {
            return [];
        }

        const siblingRows = Array.from(headerNode.parentElement.children).filter((node) => node !== headerNode && isLikelyPositionRow(node));
        if (siblingRows.length) {
            return filterLeafPositionRows(siblingRows);
        }

        return filterLeafPositionRows(allNodes.filter((node) => isLikelyPositionRow(node)));
    }

    function getColumnIndexes(table) {
        const headers = Array.from(table.querySelectorAll('thead th, tr th')).map((cell) =>
            cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase()
        );
        return {
            instrument: headers.findIndex((header) => header === 'instrument'),
            product: headers.findIndex((header) => header === 'product'),
            pnl: headers.findIndex((header) => header === 'p&l'),
            qty: headers.findIndex((header) => header === 'qty'),
            price: headers.findIndex((header) => header === 'price'),
            ltp: headers.findIndex((header) => header === 'ltp'),
        };
    }

    function collectPositionRows(table) {
        const columns = getColumnIndexes(table);
        if (columns.instrument === -1 || columns.pnl === -1) {
            return [];
        }

        const bodyRows = Array.from(table.querySelectorAll('tbody tr')).filter((row) => row.querySelectorAll('td').length);
        return bodyRows
            .map((row) => {
                const cells = Array.from(row.querySelectorAll('td'));
                const instrumentRaw = cells[columns.instrument]?.textContent?.replace(/\s+/g, ' ').trim() || '';
                const instrument = extractInstrumentName(instrumentRaw);
                const productText = columns.product >= 0 ? cells[columns.product]?.textContent?.trim() || '' : '';
                const pnlText = cells[columns.pnl]?.textContent?.trim() || '';
                const qtyText = columns.qty >= 0 ? cells[columns.qty]?.textContent?.trim() || '' : '';
                const priceText = columns.price >= 0 ? cells[columns.price]?.textContent?.trim() || '' : '';
                const ltpText = columns.ltp >= 0 ? cells[columns.ltp]?.textContent?.trim() || '' : '';
                if (!instrumentRaw) {
                    return null;
                }
                return {
                    instrumentRaw,
                    instrument,
                    pnl: parseMoney(pnlText),
                    pnlText,
                    qtyText,
                    productText,
                    priceText,
                    ltpText,
                    group: parseInstrumentGroup(instrumentRaw),
                };
            })
            .filter(Boolean);
    }

    function collectPositionRowsFromGrid(container) {
        const rows = findPositionsGridRows(container);
        return rows
            .map((row) => {
                const cells = Array.from(row.children)
                    .map((cell) => getNormalizedText(cell))
                    .filter(Boolean);

                if (cells.length < 5) {
                    return null;
                }

                const instrumentRaw = cells[0] || cells[1] || '';
                if (!looksLikeInstrumentText(instrumentRaw)) {
                    return null;
                }
                const instrument = extractInstrumentFromText(instrumentRaw) || extractInstrumentName(instrumentRaw);
                const productIndex = cells.findIndex((value) => /^(delivery|intraday|cnc|mis|nrml|bo|co)$/i.test(value.trim()));
                const qtyIndex = productIndex >= 0 ? productIndex + 1 : 2;
                const priceIndex = qtyIndex + 1;
                const ltpIndex = qtyIndex + 2;
                const pnlIndex = qtyIndex + 3;
                const productText = productIndex >= 0 ? cells[productIndex] || '' : '';
                const qtyText = cells[qtyIndex] || '';
                const priceText = cells[priceIndex] || '';
                const ltpText = cells[ltpIndex] || '';
                const pnlText = cells[pnlIndex] || cells[cells.length - 2] || cells[cells.length - 1] || '';

                if (!instrumentRaw || !instrument || !pnlText) {
                    return null;
                }

                if (!/[-+]?[\d,]+(?:\.\d+)?/.test(qtyText) || !/[-+]?[\d,]+(?:\.\d+)?/.test(priceText) || !/[-+]?[\d,]+(?:\.\d+)?/.test(ltpText) || !/[-+]?[\d,]+(?:\.\d+)?/.test(pnlText)) {
                    return null;
                }

                return {
                    instrumentRaw,
                    instrument,
                    pnl: parseMoney(pnlText),
                    pnlText,
                    qtyText,
                    productText,
                    priceText,
                    ltpText,
                    group: parseInstrumentGroup(instrumentRaw),
                };
            })
            .filter(Boolean);
    }

    function extractInstrumentFromText(text) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim().toUpperCase();
        const patterns = [
            /^([A-Z][A-Z0-9&.-]*)\s+(\d{1,2}(?:ST|ND|RD|TH)\s+[A-Z]{3})\s+FUT\b/,
            /^([A-Z][A-Z0-9&.-]*)\s+([A-Z]{3})\s+FUT\b/,
            /^([A-Z][A-Z0-9&.-]*)\s+(\d{1,2}[A-Z]{3})\s+FUT\b/,
            /^([A-Z][A-Z0-9&.-]*)\s+(\d{1,2}(?:ST|ND|RD|TH)\s+[A-Z]{3})\s+(\d+(?:\.\d+)?)\s+(CE|PE|FUT)\b/,
            /^([A-Z][A-Z0-9&.-]*)\s+([A-Z]{3})\s+(\d+(?:\.\d+)?)\s+(CE|PE|FUT)\b/,
            /^([A-Z][A-Z0-9&.-]*)\s+(\d{1,2}[A-Z]{3})\s+(\d+(?:\.\d+)?)\s+(CE|PE|FUT)\b/,
        ];

        for (const pattern of patterns) {
            const match = normalized.match(pattern);
            if (match) {
                return match.slice(1).filter(Boolean).join(' ');
            }
        }

        return '';
    }

    function getNumericTokens(text) {
        return String(text || '')
            .replace(/\u20b9/g, ' ')
            .match(/[-+]?\d[\d,]*(?:\.\d+)?/g) || [];
    }

    function collectPositionRowsByTextHeuristic(container) {
        if (!container) {
            return [];
        }

        const candidates = Array.from(container.querySelectorAll('div, section, article, tr'))
            .filter((node) => !isInsideBetterFirstockSummary(node))
            .filter((node) => {
                const text = getNormalizedText(node);
                if (!text) {
                    return false;
                }

                const lower = text.toLowerCase();
                if (lower.includes('total p&l') || looksLikeHeaderText(text)) {
                    return false;
                }

                const childTexts = Array.from(node.children).map((child) => getNormalizedText(child)).filter(Boolean);
                const instrumentSource = childTexts[0] || childTexts[1] || text;
                const instrument = extractInstrumentFromText(instrumentSource) || extractInstrumentName(instrumentSource);
                if (!instrument) {
                    return false;
                }

                return childTexts.length >= 5 && childTexts.length <= 8;
            })
            .map((node) => {
                const text = getNormalizedText(node);
                const childTexts = Array.from(node.children).map((child) => getNormalizedText(child)).filter(Boolean);
                if (childTexts.length < 5) {
                    return null;
                }

                const instrumentSource = childTexts[0] || childTexts[1] || text;
                if (!looksLikeInstrumentText(instrumentSource)) {
                    return null;
                }
                const instrument = extractInstrumentFromText(instrumentSource) || extractInstrumentName(instrumentSource);
                if (!instrument) {
                    return null;
                }

                const qtyText = childTexts[2] || '';
                const priceText = childTexts[3] || '';
                const ltpText = childTexts[4] || '';
                const pnlText = childTexts[childTexts.length - 2] || childTexts[childTexts.length - 1] || '';
                const productText = childTexts.find((value) => /^(delivery|intraday|cnc|mis|nrml|bo|co)$/i.test(value.trim())) || '';

                if (!pnlText) {
                    return null;
                }

                if (!/[-+]?[\d,]+(?:\.\d+)?/.test(qtyText) || !/[-+]?[\d,]+(?:\.\d+)?/.test(priceText) || !/[-+]?[\d,]+(?:\.\d+)?/.test(ltpText)) {
                    return null;
                }

                return {
                    instrument,
                    pnl: parseMoney(pnlText),
                    pnlText,
                    qtyText,
                    productText,
                    priceText,
                    ltpText,
                    group: parseInstrumentGroup(instrument),
                    rawText: text,
                };
            })
            .filter(Boolean);

        const uniqueRows = [];
        const seen = new Set();

        candidates.forEach((row) => {
            const key = `${row.instrument}__${row.pnlText}__${row.qtyText}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueRows.push(row);
            }
        });

        return uniqueRows;
    }

    function normalizeProductType(productText) {
        const normalized = String(productText || '').trim().toLowerCase();
        if (normalized === 'delivery') {
            return 'Delivery';
        }
        if (normalized === 'intraday' || normalized === 'mis') {
            return 'Intraday';
        }
        if (!normalized) {
            return 'Unknown';
        }
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }

    function isZeroQty(qtyText) {
        const normalized = String(qtyText || '').replace(/,/g, '').trim();
        return normalized === '0' || normalized === '0.00' || normalized === '-0' || normalized === '-0.00';
    }

    function ensurePositionsShell() {
        let summary = document.getElementById('betterfirstock-positions-summary');
        if (!summary) {
            summary = document.createElement('section');
            summary.id = 'betterfirstock-positions-summary';
            document.body.appendChild(summary);
        }
        return summary;
    }

    function findMainContentContainer() {
        return document.querySelector('[class^="applayout_mainContent__"], [class*=" applayout_mainContent__"]');
    }

    function upsertPositionsSummary(groups, anchorNode, meta = {}) {
        const summary = ensurePositionsShell();
        const mainContent = findMainContentContainer();

        if (mainContent) {
            if (summary.parentElement !== mainContent) {
                mainContent.appendChild(summary);
            } else if (mainContent.lastElementChild !== summary) {
                mainContent.appendChild(summary);
            }
        } else if (anchorNode?.parentElement) {
            if (summary.parentElement !== anchorNode.parentElement || summary.previousElementSibling !== anchorNode) {
                anchorNode.insertAdjacentElement('afterend', summary);
            }
        } else if (summary.parentElement !== document.body) {
            document.body.appendChild(summary);
        }

        const buildProductSubgroups = (positions) => {
            const subgroupMap = new Map();
            positions.forEach((position) => {
                const productType = normalizeProductType(position.productText);
                if (!subgroupMap.has(productType)) {
                    subgroupMap.set(productType, {
                        label: productType,
                        totalPnl: 0,
                        positions: [],
                    });
                }
                const bucket = subgroupMap.get(productType);
                bucket.totalPnl += position.pnl;
                bucket.positions.push(position);
            });

            return Array.from(subgroupMap.values()).sort((a, b) => {
                if (a.label === 'Delivery') return -1;
                if (b.label === 'Delivery') return 1;
                if (a.label === 'Intraday') return -1;
                if (b.label === 'Intraday') return 1;
                return a.label.localeCompare(b.label);
            });
        };

        const renderPositionRows = (positions) => positions
            .map(
                (position) => `
                    <div class="bf-grouped-position-item ${isZeroQty(position.qtyText) ? 'is-zero-qty' : ''}">
                        <span class="bf-grouped-position-name">${position.instrument}</span>
                        <span class="bf-grouped-position-meta">Qty ${position.qtyText || '-'} | P ${position.priceText || '-'} | L ${position.ltpText || '-'}</span>
                        <span class="bf-grouped-position-pnl ${position.pnl >= 0 ? 'is-profit' : 'is-loss'}">${formatMoney(position.pnl)}</span>
                    </div>
                `
            )
            .join('');

        const cards = groups
            .map((group) => {
                const hasDerivativeRows = group.positions.some((position) => position.group.assetClass === 'DERIVATIVE');

                if (hasDerivativeRows) {
                    const expiryMap = new Map();
                    group.positions.forEach((position) => {
                        const expiryLabel = position.group.expiryLabel || position.group.expiry || 'UNKNOWN EXPIRY';
                        if (!expiryMap.has(expiryLabel)) {
                            expiryMap.set(expiryLabel, {
                                label: expiryLabel,
                                totalPnl: 0,
                                positions: [],
                            });
                        }
                        const bucket = expiryMap.get(expiryLabel);
                        bucket.totalPnl += position.pnl;
                        bucket.positions.push(position);
                    });

                    const expiryGroups = Array.from(expiryMap.values()).sort((a, b) => {
                        if (a.label === 'UNKNOWN EXPIRY') return 1;
                        if (b.label === 'UNKNOWN EXPIRY') return -1;
                        return getExpirySortValue(a.label) - getExpirySortValue(b.label) || a.label.localeCompare(b.label);
                    });

                    const items = expiryGroups
                        .map((expiryGroup) => {
                            const subgroups = buildProductSubgroups(expiryGroup.positions);
                            const subgroupRows = subgroups
                                .map((subgroup) => `
                                    <div class="bf-grouped-position-subgroup">
                                        <div class="bf-grouped-position-subgroup-header">
                                            <span class="bf-grouped-position-subgroup-title">${subgroup.label}</span>
                                            <span class="bf-grouped-position-subgroup-pnl ${subgroup.totalPnl >= 0 ? 'is-profit' : 'is-loss'}">${formatMoney(subgroup.totalPnl)}</span>
                                        </div>
                                        <div class="bf-grouped-position-subgroup-items">${renderPositionRows(subgroup.positions)}</div>
                                    </div>
                                `)
                                .join('');

                            return `
                                <div class="bf-grouped-position-expiry">
                                    <div class="bf-grouped-position-expiry-header">
                                        <span class="bf-grouped-position-expiry-title">${expiryGroup.label}</span>
                                        <span class="bf-grouped-position-expiry-pnl ${expiryGroup.totalPnl >= 0 ? 'is-profit' : 'is-loss'}">${formatMoney(expiryGroup.totalPnl)}</span>
                                    </div>
                                    <div class="bf-grouped-position-expiry-items">${subgroupRows}</div>
                                </div>
                            `;
                        })
                        .join('');

                    return `
                        <article class="bf-grouped-position-card">
                            <div class="bf-grouped-position-header">
                                <div>
                                    <div class="bf-grouped-position-title">${group.label}</div>
                                    <div class="bf-grouped-position-subtitle">${group.positions.length} position${group.positions.length === 1 ? '' : 's'} | ${expiryGroups.length} expiry subgroup${expiryGroups.length === 1 ? '' : 's'}</div>
                                </div>
                                <div class="bf-grouped-position-total ${group.totalPnl >= 0 ? 'is-profit' : 'is-loss'}">${formatMoney(group.totalPnl)}</div>
                            </div>
                            <div class="bf-grouped-position-items">${items}</div>
                        </article>
                    `;
                }

                const subgroups = buildProductSubgroups(group.positions);
                const items = subgroups
                    .map((subgroup) => `
                        <div class="bf-grouped-position-subgroup">
                            <div class="bf-grouped-position-subgroup-header">
                                <span class="bf-grouped-position-subgroup-title">${subgroup.label}</span>
                                <span class="bf-grouped-position-subgroup-pnl ${subgroup.totalPnl >= 0 ? 'is-profit' : 'is-loss'}">${formatMoney(subgroup.totalPnl)}</span>
                            </div>
                            <div class="bf-grouped-position-subgroup-items">${renderPositionRows(subgroup.positions)}</div>
                        </div>
                    `)
                    .join('');

                return `
                    <article class="bf-grouped-position-card">
                        <div class="bf-grouped-position-header">
                            <div>
                                <div class="bf-grouped-position-title">${group.label}</div>
                                <div class="bf-grouped-position-subtitle">${group.positions.length} position${group.positions.length === 1 ? '' : 's'} | ${subgroups.length} subgroup${subgroups.length === 1 ? '' : 's'}</div>
                            </div>
                            <div class="bf-grouped-position-total ${group.totalPnl >= 0 ? 'is-profit' : 'is-loss'}">${formatMoney(group.totalPnl)}</div>
                        </div>
                        <div class="bf-grouped-position-items">${items}</div>
                    </article>
                `;
            })
            .join('');

        summary.innerHTML = `
            <div class="bf-grouped-position-toolbar">
                <div>
                    <div class="bf-grouped-position-heading">Grouped P&amp;L</div>
                    <div class="bf-grouped-position-caption">Grouped by underlying and expiry from the live positions table</div>
                </div>
                <button type="button" class="bf-grouped-position-refresh">Refresh</button>
            </div>
            <div class="bf-grouped-position-status">Status: ${meta.status || 'ready'}${meta.rowCount != null ? ` | Rows: ${meta.rowCount}` : ''}${meta.groupCount != null ? ` | Groups: ${meta.groupCount}` : ''}</div>
            <div class="bf-grouped-position-grid">${cards || '<div class="bf-grouped-position-empty">No position rows detected yet.</div>'}</div>
        `;

        summary.querySelector('.bf-grouped-position-refresh')?.addEventListener('click', () => {
            renderPositionsEnhancer();
        });
    }

    function renderPositionsEnhancer() {
        if (!isPositionsPage()) {
            document.getElementById('betterfirstock-positions-summary')?.remove();
            state.lastPositionsStatus = 'not-on-positions-page';
            updateDocumentTitle([]);
            return;
        }

        ensurePositionsShell();
        const table = findPositionsTable();
        const gridContainer = table ? null : findOpenPositionsContainer();
        const anchorNode = table ? (table.closest('section, div') || table) : gridContainer;
        const expectedCount = getExpectedOpenPositionsCount();
        let parser = 'table';
        let positions = [];

        if (table) {
            positions = collectPositionRows(table);
        } else if (gridContainer) {
            parser = 'grid';
            positions = collectPositionRowsFromGrid(gridContainer);
        }

        if (expectedCount != null && positions.length > expectedCount) {
            positions = positions
                .filter((position) => position.group.expiry !== 'UNKNOWN EXPIRY')
                .slice(0, expectedCount);
        }

        if (!table && !gridContainer) {
            state.lastPositionsStatus = 'table-not-found';
            state.lastPositionsMeta = { status: 'table-not-found' };
            upsertPositionsSummary([], null, state.lastPositionsMeta);
            updateDocumentTitle([]);
            return;
        }

        if (!positions.length) {
            state.lastPositionsStatus = table ? 'table-found-no-rows' : 'grid-found-no-rows';
            state.lastPositionsMeta = {
                status: state.lastPositionsStatus,
                rowCount: 0,
                groupCount: 0,
                parser,
            };
            upsertPositionsSummary([], anchorNode, state.lastPositionsMeta);
            updateDocumentTitle([]);
            return;
        }
        const groupedMap = new Map();

        positions.forEach((position) => {
            const key = position.group.basketKey || position.group.key || `${position.group.underlying}__${position.group.expiry}`;
            if (!groupedMap.has(key)) {
                groupedMap.set(key, {
                    label: position.group.basketLabel || position.group.label,
                    totalPnl: 0,
                    positions: [],
                    order: position.group.assetClass === 'EQUITY' ? 99 : (position.group.basketOrder ?? 1),
                });
            }
            const bucket = groupedMap.get(key);
            bucket.totalPnl += position.pnl;
            bucket.positions.push(position);
        });

        const groups = Array.from(groupedMap.values()).sort((a, b) => {
            if (a.order !== b.order) {
                return a.order - b.order;
            }
            return a.label.localeCompare(b.label);
        });
        state.lastPositionsStatus = 'ready';
        state.lastPositionsMeta = {
            status: 'ready',
            rowCount: positions.length,
            groupCount: groups.length,
            parser,
        };
        upsertPositionsSummary(groups, anchorNode, state.lastPositionsMeta);
        updateDocumentTitle(groups);
    }

    function installPositionsObserver() {
        const root = document.querySelector('main') || document.body;
        if (!root) {
            return;
        }

        if (state.positionsObserver) {
            state.positionsObserver.disconnect();
        }

        state.positionsObserver = new MutationObserver(() => {
            schedulePositionsEnhancer();
        });

        state.positionsObserver.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    }

    function ensureBackgroundRefreshLoop() {
        if (state.backgroundRefreshTimer) {
            return;
        }

        state.backgroundRefreshTimer = window.setInterval(() => {
            if (!isPositionsPage()) {
                return;
            }

            if (document.hidden) {
                renderPositionsEnhancer();
            }
        }, 3000);
    }

    function schedulePositionsEnhancer() {
        window.clearTimeout(state.positionsEnhancerTimer);
        state.positionsEnhancerTimer = window.setTimeout(() => {
            renderPositionsEnhancer();
        }, 200);
    }

    function observeSpaNavigation() {
        const pushState = history.pushState;
        const replaceState = history.replaceState;

        history.pushState = function () {
            const result = pushState.apply(this, arguments);
            window.dispatchEvent(new Event('betterfirstock:locationchange'));
            return result;
        };

        history.replaceState = function () {
            const result = replaceState.apply(this, arguments);
            window.dispatchEvent(new Event('betterfirstock:locationchange'));
            return result;
        };

        window.addEventListener('popstate', () => window.dispatchEvent(new Event('betterfirstock:locationchange')));
        window.addEventListener('betterfirstock:locationchange', routeChanged);
    }

    function bootstrap() {
        if (state.initialized) {
            return;
        }
        state.initialized = true;
        state.initAttempts += 1;

        registerMenu();
        observeSpaNavigation();
        ensureBadge();

        addStyle(`
            #betterfirstock-badge:hover {
                opacity: 0.92;
            }

            #betterfirstock-positions-summary {
                margin: 18px 0 0;
                padding: 16px;
                border: 1px solid rgba(148, 163, 184, 0.24);
                border-radius: 16px;
                background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.98));
                box-shadow: 0 14px 36px rgba(15, 23, 42, 0.08);
                position: relative;
                z-index: 20;
            }

            .bf-grouped-position-toolbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-bottom: 14px;
            }

            .bf-grouped-position-heading {
                font: 700 16px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
                color: #0f172a;
            }

            .bf-grouped-position-caption,
            .bf-grouped-position-subtitle,
            .bf-grouped-position-meta,
            .bf-grouped-position-empty {
                font: 500 12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
                color: #64748b;
            }

            .bf-grouped-position-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 12px;
            }

            .bf-grouped-position-status {
                margin-bottom: 12px;
                color: #475569;
                font: 600 12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
            }

            .bf-grouped-position-card {
                border: 1px solid rgba(148, 163, 184, 0.18);
                border-radius: 14px;
                padding: 14px;
                background: #ffffff;
            }

            .bf-grouped-position-header,
            .bf-grouped-position-item {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto auto;
                gap: 10px;
                align-items: center;
            }

            .bf-grouped-position-header {
                margin-bottom: 10px;
            }

            .bf-grouped-position-title,
            .bf-grouped-position-name {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: #0f172a;
            }

            .bf-grouped-position-title {
                font: 700 14px/1.3 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
            }

            .bf-grouped-position-name {
                font: 600 12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
            }

            .bf-grouped-position-item.is-zero-qty .bf-grouped-position-name,
            .bf-grouped-position-item.is-zero-qty .bf-grouped-position-meta,
            .bf-grouped-position-item.is-zero-qty .bf-grouped-position-pnl {
                color: #94a3b8;
            }

            .bf-grouped-position-total,
            .bf-grouped-position-pnl {
                font: 700 13px/1.3 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
                justify-self: end;
            }

            .bf-grouped-position-items {
                display: grid;
                gap: 8px;
            }

            .bf-grouped-position-subgroup {
                border-top: 1px solid rgba(148, 163, 184, 0.16);
                padding-top: 10px;
                display: grid;
                gap: 8px;
            }

            .bf-grouped-position-subgroup-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
            }

            .bf-grouped-position-subgroup-title {
                font: 700 12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
                color: #334155;
                text-transform: uppercase;
                letter-spacing: 0.03em;
            }

            .bf-grouped-position-subgroup-pnl {
                font: 700 12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
                margin-left: auto;
            }

            .bf-grouped-position-subgroup-items {
                display: grid;
                gap: 8px;
            }

            .bf-grouped-position-expiry {
                border-top: 1px solid rgba(148, 163, 184, 0.16);
                padding-top: 10px;
                display: grid;
                gap: 10px;
            }

            .bf-grouped-position-expiry-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
            }

            .bf-grouped-position-expiry-title {
                font: 700 12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
                color: #0f172a;
                text-transform: uppercase;
                letter-spacing: 0.04em;
            }

            .bf-grouped-position-expiry-pnl {
                font: 700 12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
                margin-left: auto;
            }

            .bf-grouped-position-expiry-items {
                display: grid;
                gap: 10px;
                padding-left: 6px;
            }

            .bf-grouped-position-refresh {
                border: 1px solid rgba(148, 163, 184, 0.3);
                border-radius: 999px;
                background: #fff;
                color: #0f172a;
                padding: 6px 12px;
                font: 600 12px/1 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
                cursor: pointer;
            }

            .bf-grouped-position-refresh:hover {
                background: #f8fafc;
            }

            .is-profit {
                color: #059669;
            }

            .is-loss {
                color: #ef4444;
            }
        `);

        debug('initialized', api);
        showToast('betterFirstock ready');

        waitForElement('body', () => {
            debug('body is ready');
        });

        installTitleLock();
        installPositionsObserver();
        ensureTitleObserver();
        ensureBackgroundRefreshLoop();
        schedulePositionsEnhancer();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
        bootstrap();
    }

    const publicApi = {
        api,
        debug,
        showToast,
        bootstrap,
        renderPositionsEnhancer,
        getPositionsDebugInfo: () => ({
            status: state.lastPositionsStatus,
            meta: state.lastPositionsMeta,
            path: window.location.pathname,
            tableFound: !!findPositionsTable(),
        }),
    };

    window.betterFirstock = publicApi;
    window.__betterFirstock = publicApi;
    pageBridge.__betterFirstock = publicApi;
    pageBridge.betterFirstock = publicApi;
})();
