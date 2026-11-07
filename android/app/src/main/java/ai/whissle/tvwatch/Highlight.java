package ai.whissle.tvwatch;

import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;

import org.json.JSONArray;
import org.json.JSONObject;

/** Arc's inline tags as colours on the transcript: each tag covers words [wb, we) of the text split on spaces. */
final class Highlight {
    private Highlight() {}

    static int color(String tag) {
        if (tag.startsWith("NUMBER")) return 0xFFFF8A73;   // colours for the dark theme
        if (tag.startsWith("CONTACT")) return 0xFFE0B070;
        switch (tag) {
            case "ENTITY_PERSON": return 0xFF7AA7FF;
            case "ENTITY_TEAM": return 0xFFC49BFF;
            case "ENTITY_PLACE": return 0xFF5FD39A;
            case "ENTITY_ORG": case "ENTITY_PRODUCT": return 0xFF4FD1C5;
            case "WATCH": return 0xFFF5C542;
            default: return 0xFFA3B1CC;   // events, works, terms, laws ...
        }
    }

    static void style(SpannableStringBuilder b, int st, int en, String tag, boolean watch) {
        int c = color(tag);
        b.setSpan(new ForegroundColorSpan(c), st, en, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        b.setSpan(new BackgroundColorSpan(watch ? 0x33F5C542 : (c & 0x00FFFFFF) | 0x26000000), st, en,
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        b.setSpan(new StyleSpan(Typeface.BOLD), st, en, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    }

    /** tapping a highlighted person / team / place / org (a callback with its text) */
    interface OnName {
        void tapped(String name, String tag);
    }

    static CharSequence of(JSONObject line, int ink) {
        return of(line, ink, null);
    }

    static CharSequence of(JSONObject line, int ink, OnName onName) {
        String text = line.optString("text");
        String[] words = text.split(" ");
        int[] start = new int[words.length + 1];
        for (int i = 0, pos = 0; i < words.length; i++) {
            start[i] = pos;
            pos += words[i].length() + 1;
        }
        start[words.length] = text.length() + 1;
        JSONArray tags = line.optJSONArray("tags");
        SpannableStringBuilder b = new SpannableStringBuilder();
        b.append(text);
        int shift = 0;   // each "★ " inserted ahead of a watchlist name moves what follows
        for (int i = 0; tags != null && i < tags.length(); i++) {
            JSONObject t = tags.optJSONObject(i);
            int wb = t.optInt("wb", -1), we = t.optInt("we", -1);
            if (wb < 0 || we <= wb || we > words.length) continue;
            String tag = t.optString("tag");
            if (tag.equals("NUMBER") || tag.equals("NUMBER_ORDINAL")) continue;   // plain counts: noise on TV
            int st = start[wb] + shift, en = Math.min(start[we] - 1, text.length()) + shift;
            while (en > st && ".,!?;:".indexOf(b.charAt(en - 1)) >= 0) en--;   // keep the full stop out
            boolean watch = !t.isNull("watch") && !t.optString("watch").isEmpty();
            if (watch) {
                b.insert(st, "★ ");
                en += 2;
                shift += 2;
            }
            style(b, st, en, tag, watch);
            if (onName != null && tag.startsWith("ENTITY")) {
                String name = b.subSequence(watch ? st + 2 : st, en).toString();
                b.setSpan(new android.text.style.ClickableSpan() {
                    @Override
                    public void onClick(android.view.View v) {
                        onName.tapped(name, tag);
                    }

                    @Override
                    public void updateDrawState(android.text.TextPaint p) {
                        p.setUnderlineText(false);   // keep the highlight's own colour
                    }
                }, st, en, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
        }
        return b;
    }
}
