// Firebase App (core) y Database
import { getDatabase, ref, get, set, update } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-database.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: "silent-gopher.firebaseapp.com",
    databaseURL: "https://silent-gopher-default-rtdb.firebaseio.com",
    projectId: "silent-gopher",
    storageBucket: "silent-gopher.appspot.com",
    messagingSenderId: process.env.FIREBASE_MESSAGINGSENDERID,
    appId: process.env.FIREBASE_API_ID,
    measurementId: "G-QS0YKFLE3G"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);