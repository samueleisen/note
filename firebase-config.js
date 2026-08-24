// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getDatabase, ref, set, get, onValue } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyB1Sl_kh1_8gijcyhP3-HfoTTzXBiFqUYc",
  authDomain: "samflow-b7814.firebaseapp.com",
  databaseURL: "https://samflow-b7814-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "samflow-b7814",
  messagingSenderId: "3706516340",
  appId: "1:3706516340:web:def4fe3041ed74f1a1b221"
};

// Initialize Firebase services
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

googleProvider.setCustomParameters({
  prompt: "select_account",
});

void setPersistence(auth, browserLocalPersistence).catch(() => {
  // Keep the app usable even if persistence cannot be set in this browser session.
});

export { auth, database, googleProvider, ref, set, get, onValue, onAuthStateChanged, signInWithPopup, signOut };
