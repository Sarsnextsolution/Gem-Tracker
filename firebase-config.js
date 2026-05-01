import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// No Firestore — profiles stored in server.js (profiles.json)
const firebaseConfig = {
  apiKey:            "AIzaSyBtEFo-xLSLyk2BEMvLbG8iZW_PHwpdHWM",
  authDomain:        "gem-df127.firebaseapp.com",
  projectId:         "gem-df127",
  storageBucket:     "gem-df127.firebasestorage.app",
  messagingSenderId: "452396925593",
  appId:             "1:452396925593:web:11b6eceb9f7b45906f2e08"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = null; // not used