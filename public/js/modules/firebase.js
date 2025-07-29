// Firebase App (core) y Database
import { getDatabase, ref, get, set, update } from 'https://www.gstatic.com/firebasejs/11.9.1/firebase-database.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";

const firebaseConfig = {
    apiKey: "AIzaSyDFVrxDNPuvyGB2mIFVPKSF8L0sUnSiud0",
    authDomain: "silent-gopher.firebaseapp.com",
    databaseURL: "https://silent-gopher-default-rtdb.firebaseio.com",
    projectId: "silent-gopher",
    storageBucket: "silent-gopher.appspot.com",
    messagingSenderId: "486923700459",
    appId: "1:486923700459:web:558987e78420a8051796ae",
    measurementId: "G-QS0YKFLE3G"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);