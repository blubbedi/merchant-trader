export class MerchantApp extends Application {
    constructor(...args) {
        super(...args);
        this.selectedMerchantId = null;
        this.selectedPlayerId = null;
        this.tradeState = { buyCart: [], sellCart: [] };
    }

    static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
            id: "merchant-trader-app",
            classes: ["dnd5e", "merchant-app-window"],
            template: "modules/merchant-trader/merchant-app.html",
            title: "Globaler Handelsplatz",
            width: 950,
            height: 700,
            resizable: true
        });
    }

    _toCopper(value, denomination) {
        const rates = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };
        const rate = rates[denomination?.toLowerCase()] || 100; 
        return (value || 0) * rate;
    }

    _formatCurrency(copperValue) {
        let cp = Math.abs(copperValue);
        let gp = Math.floor(cp / 100);
        cp %= 100;
        let sp = Math.floor(cp / 10);
        cp %= 10;
        return { gp, sp, cp };
    }

    async getData() {
        const context = super.getData();

        const merchantFolder = game.folders.find(f => f.name === "Händler" && f.type === "Actor");
        context.merchants = merchantFolder ? merchantFolder.contents : [];

        if (!this.selectedMerchantId && context.merchants.length > 0) {
            this.selectedMerchantId = context.merchants[0].id;
        }
        context.selectedMerchantId = this.selectedMerchantId;

        const merchant = game.actors.get(this.selectedMerchantId);
        if (merchant) {
            context.merchant = merchant;
            context.merchantCurrency = merchant.system.currency;
            context.merchantItems = merchant.items.contents;
        }

        const activeUsers = game.users.filter(user => user.active && user.character);
        context.players = [...new Set(activeUsers.map(user => user.character))];
        
        if (!this.selectedPlayerId) {
            this.selectedPlayerId = game.user.character?.id || (context.players.length > 0 ? context.players[0].id : null);
        }
        
        if (!context.players.find(p => p.id === this.selectedPlayerId) && context.players.length > 0) {
            this.selectedPlayerId = context.players[0].id;
        }

        context.selectedPlayerId = this.selectedPlayerId;
        const playerCharacter = game.actors.get(this.selectedPlayerId);
        context.playerCharacter = playerCharacter;

        if (playerCharacter) {
            context.playerCurrency = playerCharacter.system.currency;
            context.playerItems = playerCharacter.items.filter(i => 
                ["weapon", "equipment", "consumable", "tool", "loot"].includes(i.type)
            );
        }

        context.buyCart = this.tradeState.buyCart;
        context.sellCart = this.tradeState.sellCart;

        let totalBuyCp = 0;
        this.tradeState.buyCart.forEach(item => totalBuyCp += this._toCopper(item.price, item.denom));
        let totalSellCp = 0;
        this.tradeState.sellCart.forEach(item => totalSellCp += this._toCopper(item.price, item.denom));

        const balanceCp = totalBuyCp - totalSellCp;
        context.isPlayerPaying = balanceCp >= 0;
        context.formattedBalance = this._formatCurrency(balanceCp);
        
        context.canTrade = !!playerCharacter && !!merchant && (this.tradeState.buyCart.length > 0 || this.tradeState.sellCart.length > 0);

        return context;
    }

    activateListeners(html) {
        super.activateListeners(html);

        html.find('#merchant-selector').change(ev => {
            this.selectedMerchantId = ev.currentTarget.value;
            this.tradeState = { buyCart: [], sellCart: [] };
            this.render();
        });

        html.find('#player-selector').change(ev => {
            this.selectedPlayerId = ev.currentTarget.value;
            this.tradeState = { buyCart: [], sellCart: [] };
            this.render();
        });

        html.find('.merchant-inventory .item').dblclick(ev => {
            const itemId = ev.currentTarget.dataset.itemId;
            this._addToCart(itemId, "buy");
        });

        html.find('.player-inventory .item').dblclick(ev => {
            const itemId = ev.currentTarget.dataset.itemId;
            this._addToCart(itemId, "sell");
        });

        html.find('.cart-item').click(ev => {
            const index = ev.currentTarget.dataset.index;
            const type = ev.currentTarget.dataset.type;
            const cart = (type === "buy") ? this.tradeState.buyCart : this.tradeState.sellCart;
            cart.splice(index, 1);
            this.render();
        });

        html.find('.execute-trade').click(async ev => {
            $(ev.currentTarget).prop('disabled', true);
            await this._executeTrade();
        });
    }

    _addToCart(itemId, type) {
        const sourceActor = (type === "buy") ? game.actors.get(this.selectedMerchantId) : game.actors.get(this.selectedPlayerId);
        if (!sourceActor) return;

        const item = sourceActor.items.get(itemId);
        if (!item) return;

        const cart = (type === "buy") ? this.tradeState.buyCart : this.tradeState.sellCart;
        cart.push({
            id: item.id,
            name: item.name,
            price: item.system.price.value || 0,
            denom: item.system.price.denomination || "gp"
        });

        this.render();
    }

    async _executeTrade() {
        const merchant = game.actors.get(this.selectedMerchantId);
        const player = game.actors.get(this.selectedPlayerId);

        if (!merchant || !player) return ui.notifications.error("Handel abgebrochen: Akteur nicht gefunden.");

        let totalBuyCp = 0;
        this.tradeState.buyCart.forEach(item => totalBuyCp += this._toCopper(item.price, item.denom));
        let totalSellCp = 0;
        this.tradeState.sellCart.forEach(item => totalSellCp += this._toCopper(item.price, item.denom));

        const balanceCp = totalBuyCp - totalSellCp;
        const pCur = player.system.currency;
        let playerTotalCp = (pCur.pp * 1000) + (pCur.gp * 100) + (pCur.ep * 50) + (pCur.sp * 10) + pCur.cp;

        if (balanceCp > 0 && playerTotalCp < balanceCp) {
            return ui.notifications.warn(`${player.name} hat nicht genug Geld für diesen Handel!`);
        }

        playerTotalCp -= balanceCp;
        
        const newPlayerCurrency = {
            pp: Math.floor(playerTotalCp / 1000),
            gp: Math.floor((playerTotalCp % 1000) / 100),
            ep: pCur.ep, 
            sp: Math.floor((playerTotalCp % 100) / 10),
            cp: playerTotalCp % 10
        };
        await player.update({ "system.currency": newPlayerCurrency });

        const mCur = merchant.system.currency;
        let merchantTotalCp = (mCur.pp * 1000) + (mCur.gp * 100) + (mCur.ep * 50) + (mCur.sp * 10) + mCur.cp;
        merchantTotalCp += balanceCp; 
        
        const newMerchantCurrency = {
            pp: Math.floor(merchantTotalCp / 1000),
            gp: Math.floor((merchantTotalCp % 1000) / 100),
            ep: mCur.ep,
            sp: Math.floor((merchantTotalCp % 100) / 10),
            cp: merchantTotalCp % 10 || 0
        };
        await merchant.update({ "system.currency": newMerchantCurrency });

        for (const cartItem of this.tradeState.buyCart) {
            const sourceItem = merchant.items.get(cartItem.id);
            if (sourceItem) {
                let itemData = sourceItem.toObject();
                itemData.system.quantity = 1;
                await player.createEmbeddedDocuments("Item", [itemData]);

                if (sourceItem.system.quantity > 1) {
                    await merchant.updateEmbeddedDocuments("Item", [{ _id: sourceItem.id, "system.quantity": sourceItem.system.quantity - 1 }]);
                } else {
                    await merchant.deleteEmbeddedDocuments("Item", [sourceItem.id]);
                }
            }
        }

        for (const cartItem of this.tradeState.sellCart) {
            const sourceItem = player.items.get(cartItem.id);
            if (sourceItem) {
                let itemData = sourceItem.toObject();
                itemData.system.quantity = 1;
                await merchant.createEmbeddedDocuments("Item", [itemData]);

                if (sourceItem.system.quantity > 1) {
                    await player.updateEmbeddedDocuments("Item", [{ _id: sourceItem.id, "system.quantity": sourceItem.system.quantity - 1 }]);
                } else {
                    await player.deleteEmbeddedDocuments("Item", [sourceItem.id]);
                }
            }
        }

        this.tradeState = { buyCart: [], sellCart: [] };
        this.render();
        ui.notifications.info(`Handel erfolgreich abgeschlossen!`);
    }
}

Hooks.on('getSceneControlButtons', (controls) => {
    const tokenControls = controls.find(c => c.name === 'token');
    if (tokenControls) {
        tokenControls.tools.push({
            name: 'merchant-trader',
            title: 'Handelsplatz öffnen',
            icon: 'fas fa-balance-scale',
            button: true,
            visible: game.user.isGM,
            onClick: () => {
                new MerchantApp().render(true);
            }
        });
    }
});