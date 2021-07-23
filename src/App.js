import logo from './logo.svg';
import './App.css';
import React,{useState} from 'react';


function App() {
  
  let [글제목,글제목변경] = useState(['react','react2','react3']);
  let posts = "고기맛집";
  let [따봉,따봉변경] = useState(0);

  function 제목바꾸기(){
    let newArray = [...글제목];
    newArray[0] = '여자코트추천';
    글제목변경(newArray);
  }
  return (
    <div className="App">
        <div className="black-nav">
          <div>개발dd Blog</div>
        </div>
        
        <div className="list">
          <button onClick={ 제목바꾸기 }>버튼</button>
          <h4>{글제목[0]}<span onClick={ ()=> { 따봉변경(따봉+1) } } > 👍 </span>{따봉} </h4>
          <p>날짜</p>
          <hr></hr>
        </div>
        <div className="list">
          <h4>{글제목[1]}</h4>
          <p>날짜</p>
          <hr></hr>
        </div>
        <div className="list">
          <h4>{글제목[2]}</h4>
          <p>날짜</p>
          <hr></hr>
        </div>
        <Modal></Modal>     
    </div>
  );
}
function Modal(){
  return(
    <div className='modal'>
          <h2>제목</h2>
          <p>내용</p>
          <p>상세내용</p>
    </div>

  )
}
export default App;
