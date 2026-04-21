// ==========================================
// 1. INITIALISIERUNG
// ==========================================
Hooks.once('ready', () => {
    console.log("Merchant Trader V2 | Initialisiert (v2.6.0 - Hell Update)");
});

// ==========================================
// 2. SETUP APP
// ==========================================
window.MerchantSetupApp = class MerchantSetupApp extends Application {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "merchant-setup-app",
            classes: ["dnd5e", "merchant-setup-window"],
            template: "modules/merchant-trader-v2/merchant-setup.html",
            title: "Handelsplatz vorbereiten",
            width: 400,
            height: "auto"
        });
    }

    getData() {
        const merchantFolder = game.folders.find(f => f.name === "Händler" && f.type === "Actor");
        const activeUsers = game.users.filter(user => user.active && user.character);
        return {
            merchants: merchantFolder ? merchantFolder.contents : [],
            players: [...new Set(activeUsers.map(u => u.character))],
            canStart: merchantFolder && merchantFolder.contents.length > 0
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        
        html.find('#setup-sell-factor').on('input', ev => {
            const val = Math.round(ev.target.value * 100);
            html.find('#factor-display').text(val + "%");
        });

        html.find('#start-trade-btn').click(async ev => {
            const mId = html.find('#setup-merchant-id').val();
            const pId = html.find('#setup-player-id').val();
            const sFactor = parseFloat(html.find('#setup-sell-factor').val()); 
            const isSoulMode = html.find('#setup-soul-coin-mode').is(':checked');
            
            if (window.currentTradeApp) window.currentTradeApp.close();
            window.currentTradeApp = new window.MerchantTradeApp(mId, pId);
            window.currentTradeApp.render(true);

            const playerChar = game.actors.get(pId);
            if (playerChar) {
                await playerChar.setFlag("merchant-trader-v2", "tradeState", {
                    active: true,
                    status: "trading",
                    merchantId: mId,
                    sellFactor: sFactor, 
                    buyFactor: 1.0, 
                    isSoulMode: isSoulMode,
                    haggleAttempted: false,
                    timestamp: Date.now(),
                    buyCart: [], 
                    sellCart: []
                });
            }
            this.close();
        });
    }
};

// ==========================================
// 3. HAUPT APP (HANDEL)
// ==========================================
window.MerchantTradeApp = class MerchantTradeApp extends Application {
    constructor(merchantId, playerId, options = {}) {
        super(options);
        this.merchantId = merchantId;
        this.playerId = playerId;
        this.tradeState = { buyCart: [], sellCart: [] };
        this.lastTimestamp = 0; 
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "merchant-trade-app",
            classes: ["dnd5e", "merchant-app-window"],
            template: "modules/merchant-trader-v2/merchant-app.html",
            title: "Globaler Handelsplatz",
            width: 950,
            height: 700,
            resizable: true,
            dragDrop: [{ dragSelector: ".item", dropSelector: ".trade-container" }] 
        });
    }

    async close(options={}) {
        window.currentTradeApp = null;
        return super.close(options);
    }

    // --- DRAG & DROP HANDLER ---
    _canDragStart(selector) { return true; }
    _canDragDrop(selector) { return true; }

    _onDragStart(event) {
        const li = event.currentTarget;
        const itemId = li.dataset.itemId;
        if (li.classList.contains("out-of-stock")) return;
        const isMerchantItem = li.closest(".merchant-inventory");
        const type = isMerchantItem ? "buy" : "sell";
        const dragData = { type: "MerchantItem", payload: { itemId, type } };
        event.dataTransfer.setData("text/plain", JSON.stringify(dragData));
    }

    async _onDrop(event) {
        event.preventDefault();
        const data = TextEditor.getDragEventData(event);
        if (data.type !== "MerchantItem") return;
        const { itemId, type } = data.payload;
        this._addToCart(itemId, type);
    }

    // --- HILFSFUNKTIONEN ---
    _getSoulCoinQty(actor) {
        if (!actor) return 0;
        const item = actor.items.find(i => i.name === "Seelenmünze");
        return item ? item.system.quantity : 0;
    }

    _toCopper(value, denomination) {
        const rates = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };
        return (value || 0) * (rates[denomination?.toLowerCase()] || 100);
    }

    _formatCurrency(copperValue) {
        let cp = Math.abs(copperValue);
        let gp = Math.floor(cp / 100); cp %= 100;
        let sp = Math.floor(cp / 10); cp %= 10;
        return { gp, sp, cp };
    }

    _getActorMoney(actor) {
        const c = actor?.system?.currency || {};
        return ((c.pp||0)*1000) + ((c.gp||0)*100) + ((c.ep||0)*50) + ((c.sp||0)*10) + (c.cp||0);
    }

    async _updateFlag(updates = {}) {
        const playerChar = game.actors.get(this.playerId);
        if (playerChar) {
            const oldFlag = playerChar.getFlag("merchant-trader-v2", "tradeState") || {};
            await playerChar.setFlag("merchant-trader-v2", "tradeState", {
                ...oldFlag,
                ...updates,
                timestamp: Date.now()
            });
        }
    }

    _categorizeItems(docItems, cart, isSoulMode) {
        const categories = {
            weapon: { label: "Waffen", items: [] },
            equipment: { label: "Ausrüstung", items: [] },
            consumable: { label: "Verbrauchsgüter", items: [] },
            tool: { label: "Werkzeuge", items: [] },
            backpack: { label: "Behälter", items: [] },
            loot: { label: "Beute & Sonstiges", items: [] }
        };

        for (let doc of docItems) {
            if (isSoulMode && doc.name === "Seelenmünze") continue;
            if (!categories[doc.type] && doc.type !== "loot") continue;

            let item = doc.toObject(); 
            const cartEntry = cart.find(e => e.id === doc.id); 
            const inCartQty = cartEntry ? cartEntry.quantity : 0;
            const originalMaxQty = item.system.quantity || 1;
            const remainingQty = Math.max(0, originalMaxQty - inCartQty);
            
            item.system.quantity = remainingQty;
            item.isStackFull = (remainingQty === 0);

            if (isSoulMode) {
                const gpPrice = this._toCopper(item.system.price.value, item.system.price.denomination) / 100;
                item.displayPrice = (gpPrice / 1000).toFixed(3) + " SC";
            } else {
                item.displayPrice = item.system.price.value + " " + item.system.price.denomination;
            }

            const key = categories[item.type] ? item.type : "loot";
            categories[key].items.push(item);
        }

        const result = {};
        for (let [key, cat] of Object.entries(categories)) {
            if (cat.items.length > 0) {
                cat.items.sort((a, b) => a.name.localeCompare(b.name));
                result[key] = cat;
            }
        }
        return result;
    }

    async getData() {
        const merchant = game.actors.get(this.merchantId);
        const playerCharacter = game.actors.get(this.playerId);
        const flag = playerCharacter?.getFlag("merchant-trader-v2", "tradeState");
        
        const isSoulMode = flag?.isSoulMode || false;
        const sellFactor = flag?.sellFactor ?? 0.5;
        const buyFactor = flag?.buyFactor ?? 1.0; 

        if (flag) {
            this.tradeState.buyCart = flag.buyCart || [];
            this.tradeState.sellCart = flag.sellCart || [];
            this.lastTimestamp = flag.timestamp;
        }

        let totalBuyCp = 0;
        this.tradeState.buyCart.forEach(item => {
            const basePrice = this._toCopper(item.price, item.denom);
            const finalPrice = Math.floor(basePrice * buyFactor);
            totalBuyCp += (finalPrice * item.quantity);
        });
        
        let totalSellCp = 0;
        this.tradeState.sellCart.forEach(item => {
            const basePrice = this._toCopper(item.price, item.denom);
            const finalPrice = Math.floor(basePrice * sellFactor);
            totalSellCp += (finalPrice * item.quantity);
        });

        const balanceCp = totalBuyCp - totalSellCp;
        
        let formattedBalance = "";
        let playerMoney = 0;
        let merchantMoney = 0;
        let canAfford = true;
        let currencyError = "";

        if (isSoulMode) {
            const scRate = 100000;
            formattedBalance = (Math.abs(balanceCp) / scRate).toFixed(2) + " SC";
            playerMoney = this._getSoulCoinQty(playerCharacter);
            merchantMoney = this._getSoulCoinQty(merchant);

            const requiredSC = Math.ceil(Math.abs(balanceCp) / scRate);

            if (balanceCp > 0 && playerMoney < requiredSC) {
                canAfford = false;
                currencyError = "Spieler hat zu wenig Seelenmünzen!";
            } else if (balanceCp < 0 && merchantMoney < requiredSC) {
                canAfford = false;
                currencyError = "Händler hat zu wenig Seelenmünzen!";
            }
        } else {
            const gpSpCp = this._formatCurrency(balanceCp);
            formattedBalance = `${gpSpCp.gp} GP`;
            playerMoney = this._getActorMoney(playerCharacter);
            merchantMoney = this._getActorMoney(merchant);

            if (balanceCp > 0 && playerMoney < balanceCp) {
                canAfford = false;
                currencyError = "Spieler hat zu wenig Geld!";
            } else if (balanceCp < 0 && merchantMoney < Math.abs(balanceCp)) {
                canAfford = false;
                currencyError = "Händler hat zu wenig Geld!";
            }
        }

        const cartsNotEmpty = (this.tradeState.buyCart.length > 0 || this.tradeState.sellCart.length > 0);
        const canTrade = !!playerCharacter && !!merchant && cartsNotEmpty && canAfford;

        const rawMerchantItems = merchant?.items.contents || [];
        const rawPlayerItems = playerCharacter?.items.contents || [];

        return {
            isGM: game.user.isGM,
            merchant,
            merchantCurrency: merchant?.system.currency,
            playerCharacter,
            playerCurrency: playerCharacter?.system.currency,
            isSoulMode,
            playerMoney,
            merchantMoney,
            merchantCategories: this._categorizeItems(rawMerchantItems, this.tradeState.buyCart, isSoulMode),
            playerCategories: this._categorizeItems(rawPlayerItems, this.tradeState.sellCart, isSoulMode),
            buyCart: this.tradeState.buyCart,
            sellCart: this.tradeState.sellCart,
            isPlayerPaying: balanceCp >= 0,
            formattedBalance,
            canTrade: canTrade,
            currencyError: currencyError,
            sellFactorDisplay: Math.round(sellFactor * 100),
            buyFactorDisplay: Math.round(buyFactor * 100),
            haggleAttempted: flag?.haggleAttempted || false
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        
        html.find('.merchant-inventory .item').dblclick(ev => this._addToCart(ev.currentTarget.dataset.itemId, "buy"));
        html.find('.player-inventory .item').dblclick(ev => this._addToCart(ev.currentTarget.dataset.itemId, "sell"));

        html.find('.cart-item').click(ev => {
            const { index, type } = ev.currentTarget.dataset;
            const cart = (type === "buy" ? this.tradeState.buyCart : this.tradeState.sellCart);
            const item = cart[index];
            if (item.quantity > 1) item.quantity--; else cart.splice(index, 1);
            this.render(); 
            this._updateFlag({ buyCart: this.tradeState.buyCart, sellCart: this.tradeState.sellCart });
        });

        html.find('.haggle-btn').click(async ev => {
            const skillId = ev.currentTarget.dataset.skill;
            await this._onHaggle(skillId);
        });

        html.find('.execute-trade').click(async ev => {
            ev.currentTarget.disabled = true;
            await this._executeTrade();
        });

        html.find('.player-accept').click(async ev => {
            ev.currentTarget.disabled = true;
            ui.notifications.info("Warte auf Bestätigung des Händlers...");
            await this._updateFlag({ status: "accepted" });
            this.close();
        });

        html.find('.player-cancel').click(async ev => {
            ev.currentTarget.disabled = true;
            await this._updateFlag({ status: "cancelled" });
            this.close();
        });
    }

    async _onHaggle(skillId) {
        const player = game.actors.get(this.playerId);
        if (!player) return;

        const roll = await player.rollSkill(skillId);
        if (!roll) return; 

        const total = roll.total;
        const flag = player.getFlag("merchant-trader-v2", "tradeState");
        let newSellFactor = flag.sellFactor || 0.5;
        let newBuyFactor = flag.buyFactor || 1.0;
        let message = "";

        if (total >= 20) {
            newSellFactor += 0.2; 
            newBuyFactor -= 0.2;  
            message = "Kritischer Erfolg! Traumkonditionen (+20% Verkauf / -20% Einkauf).";
        } else if (total >= 15) {
            newSellFactor += 0.1; 
            newBuyFactor -= 0.1;  
            message = "Erfolg! Bessere Preise ausgehandelt (+10% Verkauf / -10% Einkauf).";
        } else {
            message = "Das hat nicht geklappt. Der Händler bleibt hart.";
        }

        if (newSellFactor > 1.0) newSellFactor = 1.0;
        if (newBuyFactor < 0.1) newBuyFactor = 0.1; 

        ui.notifications.info(message);

        await this._updateFlag({
            sellFactor: newSellFactor,
            buyFactor: newBuyFactor, 
            haggleAttempted: true 
        });
    }

    _addToCart(itemId, type) {
        const sourceActor = game.actors.get(type === "buy" ? this.merchantId : this.playerId);
        const item = sourceActor?.items.get(itemId);
        if (!item) return;

        const cart = (type === "buy" ? this.tradeState.buyCart : this.tradeState.sellCart);
        const existingEntry = cart.find(entry => entry.id === item.id);
        const maxQty = item.system.quantity || 1;

        if (existingEntry) {
            if (existingEntry.quantity < maxQty) existingEntry.quantity++;
            else { ui.notifications.warn("Nicht genug auf Lager."); return; }
        } else {
            cart.push({ id: item.id, name: item.name, img: item.img, price: item.system.price.value||0, denom: item.system.price.denomination||"gp", quantity: 1, maxQty: maxQty });
        }
        this.render();
        this._updateFlag({ buyCart: this.tradeState.buyCart, sellCart: this.tradeState.sellCart });
    }

    async _executeTrade() {
        if (!game.user.isGM) return;
        
        const merchant = game.actors.get(this.merchantId);
        const player = game.actors.get(this.playerId);
        const flag = player.getFlag("merchant-trader-v2", "tradeState");
        
        const isSoulMode = flag?.isSoulMode || false;
        const sellFactor = flag?.sellFactor ?? 0.5;
        const buyFactor = flag?.buyFactor ?? 1.0;

        let totalBuyCp = 0;
        this.tradeState.buyCart.forEach(item => {
            const basePrice = this._toCopper(item.price, item.denom);
            const finalPrice = Math.floor(basePrice * buyFactor);
            totalBuyCp += (finalPrice * item.quantity);
        });
        
        let totalSellCp = 0;
        this.tradeState.sellCart.forEach(item => {
            const basePrice = this._toCopper(item.price, item.denom);
            const finalPrice = Math.floor(basePrice * sellFactor);
            totalSellCp += (finalPrice * item.quantity);
        });

        const balanceCp = totalBuyCp - totalSellCp;
        const pTotal = this._getActorMoney(player);
        const mTotal = this._getActorMoney(merchant);

        if (isSoulMode) {
            const scAmount = Math.ceil(Math.abs(balanceCp) / 100000);
            if (balanceCp > 0 && this._getSoulCoinQty(player) < scAmount) return ui.notifications.warn("Spieler hat nicht genug Seelenmünzen!");
            if (balanceCp < 0 && this._getSoulCoinQty(merchant) < scAmount) return ui.notifications.warn("Händler hat nicht genug Seelenmünzen!");
        } else {
            if (balanceCp > 0 && pTotal < balanceCp) return ui.notifications.warn("Spieler hat nicht genug Geld (Abbruch)!");
            if (balanceCp < 0 && mTotal < Math.abs(balanceCp)) return ui.notifications.warn("Händler hat nicht genug Geld (Abbruch)!");
        }

        if (isSoulMode) {
            const scAmount = Math.round(Math.abs(balanceCp) / 100000);
            if (scAmount > 0) {
                const payer = balanceCp > 0 ? player : merchant;
                const receiver = balanceCp > 0 ? merchant : player;
                
                const coinItem = payer.items.find(i => i.name === "Seelenmünze");
                if (coinItem && coinItem.system.quantity >= scAmount) {
                    let receiverCoin = receiver.items.find(i => i.name === "Seelenmünze");
                    if (receiverCoin) {
                        await receiverCoin.update({ "system.quantity": receiverCoin.system.quantity + scAmount });
                    } else {
                        await receiver.createEmbeddedDocuments("Item", [{ name: "Seelenmünze", type: "loot", img: coinItem.img, "system.quantity": scAmount }]);
                    }
                    if (coinItem.system.quantity === scAmount) await coinItem.delete();
                    else await coinItem.update({ "system.quantity": coinItem.system.quantity - scAmount });
                }
            }
        } else {
            const newPTotal = pTotal - balanceCp; 
            const newMTotal = mTotal + balanceCp; 
            const dist = (cp) => {
                let gp = Math.floor(cp / 100); cp %= 100; let sp = Math.floor(cp / 10); cp %= 10;
                return { pp: 0, gp, ep: 0, sp, cp };
            };
            await player.update({ "system.currency": dist(newPTotal) });
            await merchant.update({ "system.currency": dist(newMTotal) });
        }

        const transferItems = async (cart, source, target) => {
            for (let entry of cart) {
                let item = source.items.get(entry.id);
                if (!item) continue;
                let itemData = item.toObject();
                itemData.system.quantity = entry.quantity;

                const existingItem = target.items.find(i => i.name === itemData.name && i.type === itemData.type);
                if (existingItem) {
                    const newQty = existingItem.system.quantity + entry.quantity;
                    await existingItem.update({"system.quantity": newQty});
                } else {
                    await target.createEmbeddedDocuments("Item", [itemData]);
                }

                const remaining = item.system.quantity - entry.quantity;
                if (remaining > 0) {
                    await source.updateEmbeddedDocuments("Item", [{_id: item.id, "system.quantity": remaining}]);
                } else {
                    await source.deleteEmbeddedDocuments("Item", [item.id]);
                }
            }
        };

        await transferItems(this.tradeState.buyCart, merchant, player);
        await transferItems(this.tradeState.sellCart, player, merchant);

        const postChat = true; 
        if (postChat) {
            let chatContent = `<div class="dnd5e chat-card">
                <header class="card-header flexrow">
                    <img src="${merchant.img}" title="${merchant.name}" width="36" height="36"/>
                    <h3 style="align-self: center;">Handel abgeschlossen</h3>
                </header>
                <div class="card-content" style="padding: 5px;">
                    <p><b>${player.name}</b> hat gehandelt mit <b>${merchant.name}</b>.</p>
                    <hr>`;
            
            if (this.tradeState.buyCart.length > 0) {
                chatContent += `<p><b>Gekauft:</b><br>`;
                this.tradeState.buyCart.forEach(i => chatContent += `- ${i.quantity}x ${i.name}<br>`);
                chatContent += `</p>`;
            }

            if (this.tradeState.sellCart.length > 0) {
                chatContent += `<p><b>Verkauft:</b><br>`;
                this.tradeState.sellCart.forEach(i => chatContent += `- ${i.quantity}x ${i.name}<br>`);
                chatContent += `</p>`;
            }

            let totalStr = "";
            if (isSoulMode) {
                totalStr = `${(Math.abs(balanceCp) / 100000).toFixed(2)} Seelenmünzen`;
            } else {
                const formatted = this._formatCurrency(balanceCp);
                totalStr = `${formatted.gp}g ${formatted.sp}s ${formatted.cp}k`;
            }
            
            if (balanceCp > 0) chatContent += `<hr><p><b>Bezahlt:</b> ${totalStr}</p>`;
            else if (balanceCp < 0) chatContent += `<hr><p><b>Erhalten:</b> ${totalStr}</p>`;
            else chatContent += `<hr><p><b>Tausch ohne Goldfluss.</b></p>`;

            chatContent += `</div></div>`;

            ChatMessage.create({
                content: chatContent,
                speaker: { alias: merchant.name }
            });
        }

        await player.unsetFlag("merchant-trader-v2", "tradeState");
        this.close(); 
        ui.notifications.info("Handel erfolgreich!");
    }
};

Hooks.on('updateActor', (actor, data, options, userId) => {
    if (foundry.utils.hasProperty(data, "flags.merchant-trader-v2.tradeState")) {
        const flagData = actor.getFlag("merchant-trader-v2", "tradeState");
        const myChar = game.user.character;

        if (!flagData) {
            if (window.currentTradeApp) window.currentTradeApp.close();
            return;
        }

        if (game.user.isGM) {
            if (flagData.status === "cancelled") {
                actor.unsetFlag("merchant-trader-v2", "tradeState");
                ui.notifications.info("Handel vom Spieler abgebrochen.");
                if (window.currentTradeApp) window.currentTradeApp.close();
            }
            else if (flagData.status === "accepted") {
                if (window.currentTradeApp) window.currentTradeApp._executeTrade();
            }
            else if (window.currentTradeApp && window.currentTradeApp.playerId === actor.id) {
                window.currentTradeApp.render(false);
            }
            return;
        }

        if (myChar && myChar.id === actor.id && !game.user.isGM) {
            if (flagData.active && flagData.status === "trading") {
                const app = window.currentTradeApp;
                const isNew = !app || app.merchantId !== flagData.merchantId;

                if (isNew) {
                    if (app) app.close();
                    window.currentTradeApp = new window.MerchantTradeApp(flagData.merchantId, actor.id);
                    window.currentTradeApp.render(true);
                } else {
                    app.tradeState = flagData;
                    app.render(false);
                }
            }
        }
    }
});

Hooks.on('getSceneControlButtons', (controls) => {
    const tokenControls = controls.find(c => c.name === 'token');
    tokenControls?.tools.push({
        name: 'merchant-trader',
        title: 'Handel vorbereiten',
        icon: 'fas fa-balance-scale',
        button: true,
        visible: game.user.isGM,
        onClick: () => new window.MerchantSetupApp().render(true)
    });
});